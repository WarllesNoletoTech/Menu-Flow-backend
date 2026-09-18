import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { Role } from '../common/roles';
import { Order, RestaurantSettings, RestaurantTable, TableEvent, TableSession, User } from '../common/schemas';
import { OrdersService, type CheckoutItem } from '../orders/orders.service';
import type { TablePermission } from './table-permissions';
import { PrinterService } from '../printer/printer.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CashRegisterService } from '../cash-register/cash-register.service';

export type TableActor = { sub: string; role: Role; restaurantId: string };

@Injectable()
export class TablesService {
  private readonly logger = new Logger(TablesService.name);
  constructor(
    @InjectModel(RestaurantTable.name) private readonly tables: Model<RestaurantTable>,
    @InjectModel(TableSession.name) private readonly sessions: Model<TableSession>,
    @InjectModel(TableEvent.name) private readonly tableEvents: Model<TableEvent>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(RestaurantSettings.name) private readonly settings: Model<RestaurantSettings>,
    private readonly ordersService: OrdersService,
    private readonly printer: PrinterService,
    private readonly notifications: NotificationsService,
    private readonly cashRegister: CashRegisterService,
  ) {}

  async context(actor: TableActor) {
    await this.assertPermission(actor, 'TABLES_VIEW');
    const rid = this.rid(actor);
    const [settings, tables, initialSessions] = await Promise.all([
      this.settings.findOne({ restaurantId: rid }).select('tableServiceEnabled waiterAppEnabled serviceFeePercent qrOrderingEnabled qrRequireWaiterApproval').lean(),
      this.tables.find({ restaurantId: rid }).sort({ sortOrder: 1, number: 1 }).lean(),
      this.sessions.find({ restaurantId: rid, status: { $ne: 'CLOSED' } }).populate('waiterId', 'name').sort({ openedAt: 1 }).lean(),
    ]);
    await Promise.all(initialSessions.map((session) => this.recalculate(session._id)));
    const sessions = await this.sessions.find({ restaurantId: rid, status: { $ne: 'CLOSED' } }).populate('waiterId', 'name').sort({ openedAt: 1 }).lean();
    const sessionIds = sessions.map((session) => session._id);
    const orders = sessionIds.length
      ? await this.orders.find({ restaurantId: rid, tableSessionId: { $in: sessionIds } }).sort({ createdAt: 1 }).lean()
      : [];
    const ordersBySession = new Map<string, any[]>();
    for (const order of orders) {
      const key = order.tableSessionId?.toString();
      if (!key) continue;
      const list = ordersBySession.get(key) ?? [];
      list.push(order);
      ordersBySession.set(key, list);
    }
    return {
      settings: {
        tableServiceEnabled: settings?.tableServiceEnabled ?? false,
        waiterAppEnabled: settings?.waiterAppEnabled ?? false,
        serviceFeePercent: settings?.serviceFeePercent ?? 10,
        qrOrderingEnabled: settings?.qrOrderingEnabled ?? false,
        qrRequireWaiterApproval: settings?.qrRequireWaiterApproval ?? true,
      },
      tables,
      sessions: sessions.map((session) => ({ ...session, orders: ordersBySession.get(session._id.toString()) ?? [] })),
    };
  }

  async waiters(actor: TableActor) {
    await this.assertPermission(actor, 'TABLES_VIEW');
    const items = await this.users.find({ restaurantId: this.rid(actor), role: Role.EMPLOYEE, active: true, deletedAt: null, permissions: 'TABLES_VIEW' })
      .select('name employeePosition permissions').sort({ name: 1 }).lean();
    return items.map((item) => ({ id: item._id.toString(), name: item.name, employeePosition: item.employeePosition, permissions: item.permissions ?? [] }));
  }

  async bulkCreate(actor: TableActor, input: { from: number; to: number; prefix?: string; capacity?: number }) {
    this.assertOwner(actor);
    const rid = this.rid(actor);
    if (input.to < input.from) throw new BadRequestException('A mesa final deve ser maior ou igual à inicial.');
    if (input.to - input.from + 1 > 200) throw new BadRequestException('Crie no máximo 200 mesas por vez.');
    const prefix = input.prefix?.trim() || 'Mesa';
    const existing = new Set((await this.tables.find({ restaurantId: rid, number: { $gte: input.from, $lte: input.to } }).select('number').lean()).map((table) => table.number));
    const docs = [];
    for (let number = input.from; number <= input.to; number += 1) {
      if (existing.has(number)) continue;
      docs.push({
        restaurantId: rid,
        number,
        name: `${prefix} ${String(number).padStart(2, '0')}`,
        capacity: input.capacity ?? 4,
        active: true,
        sortOrder: number,
        qrToken: randomBytes(18).toString('base64url'),
      });
    }
    if (docs.length) await this.tables.insertMany(docs, { ordered: false });
    return { created: docs.length, skipped: existing.size };
  }

  async updateTable(actor: TableActor, tableId: string, input: { name?: string; capacity?: number; active?: boolean }) {
    this.assertOwner(actor);
    const rid = this.rid(actor);
    const tid = this.oid(tableId, 'Mesa não encontrada.');
    if (input.active === false && await this.sessions.exists({ restaurantId: rid, tableIds: tid, status: { $ne: 'CLOSED' } })) {
      throw new ConflictException('Feche a comanda desta mesa antes de desativá-la.');
    }
    const table = await this.tables.findOneAndUpdate(
      { _id: tid, restaurantId: rid },
      { $set: input },
      { new: true, runValidators: true },
    ).lean();
    if (!table) throw new NotFoundException('Mesa não encontrada.');
    return table;
  }

  async open(actor: TableActor, tableId: string, input: { customerName?: string; peopleCount?: number; waiterId?: string }) {
    await this.assertPermission(actor, 'TABLES_OPEN');
    const rid = this.rid(actor);
    await this.assertEnabled(rid);
    const table = await this.tables.findOne({ _id: this.oid(tableId, 'Mesa não encontrada.'), restaurantId: rid, active: true }).lean();
    if (!table) throw new NotFoundException('Mesa não encontrada ou desativada.');
    if (await this.sessions.exists({ restaurantId: rid, tableIds: table._id, status: { $ne: 'CLOSED' } })) throw new ConflictException('Esta mesa já possui uma comanda aberta.');
    const waiterId = input.waiterId ? await this.validWaiter(rid, input.waiterId) : (actor.role === Role.EMPLOYEE ? this.oid(actor.sub, 'Funcionário inválido.') : undefined);
    const settings = await this.settings.findOne({ restaurantId: rid }).lean();
    let session;
    try {
      session = await this.sessions.create({
        restaurantId: rid,
        primaryTableId: table._id,
        tableIds: [table._id],
        status: 'OPEN',
        active: true,
        openedBy: this.oid(actor.sub, 'Responsável inválido.'),
        waiterId,
        customerName: input.customerName?.trim() || undefined,
        peopleCount: input.peopleCount ?? 1,
        serviceFeePercent: settings?.serviceFeePercent ?? 10,
        subtotalCents: 0,
        serviceFeeCents: 0,
        discountCents: 0,
        totalCents: 0,
        paidCents: 0,
        balanceCents: 0,
        openedAt: new Date(),
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException('Esta mesa acabou de ser aberta por outro usuário. Atualize a tela.');
      throw error;
    }
    await this.event(actor, session._id, 'TABLE_OPENED', table._id, { tableName: table.name, peopleCount: session.peopleCount, customerName: session.customerName });
    return this.session(actor, session._id.toString());
  }

  async session(actor: TableActor, sessionId: string) {
    await this.assertPermission(actor, 'TABLES_VIEW');
    const rid = this.rid(actor);
    const sid = this.oid(sessionId, 'Comanda não encontrada.');
    if (!(await this.sessions.exists({ _id: sid, restaurantId: rid }))) throw new NotFoundException('Comanda não encontrada.');
    await this.recalculate(sid);
    const session = await this.sessions.findOne({ _id: sid, restaurantId: rid })
      .populate('waiterId', 'name email phone employeePosition')
      .populate('tableIds', 'number name capacity active qrToken')
      .lean();
    if (!session) throw new NotFoundException('Comanda não encontrada.');
    const orders = await this.orders.find({ restaurantId: rid, tableSessionId: session._id }).sort({ createdAt: 1 }).lean();
    return { ...session, orders };
  }

  async events(actor: TableActor, sessionId: string) {
    await this.assertPermission(actor, 'TABLES_VIEW');
    const rid = this.rid(actor);
    const sid = this.oid(sessionId, 'Comanda não encontrada.');
    if (!(await this.sessions.exists({ _id: sid, restaurantId: rid }))) throw new NotFoundException('Comanda não encontrada.');
    return this.tableEvents.find({ restaurantId: rid, tableSessionId: sid }).populate('actorId', 'name').sort({ createdAt: -1 }).limit(200).lean();
  }

  async addOrder(actor: TableActor, sessionId: string, items: CheckoutItem[]) {
    await this.assertPermission(actor, 'TABLES_ORDER');
    const rid = this.rid(actor);
    await this.assertEnabled(rid);
    const session = await this.activeSession(rid, sessionId);
    if (session.status !== 'OPEN') throw new ConflictException('A conta já foi solicitada e esta comanda não aceita novos itens.');
    const table = await this.tables.findById(session.primaryTableId).lean();
    if (!table) throw new NotFoundException('Mesa não encontrada.');
    const order = await this.ordersService.createTableOrder(actor.restaurantId, {
      tableId: table._id.toString(),
      tableSessionId: session._id.toString(),
      waiterId: session.waiterId?.toString() || (actor.role === Role.EMPLOYEE ? actor.sub : undefined),
      tableName: table.name,
      items,
    }, actor.sub);
    await this.recalculate(session._id);
    await this.event(actor, session._id, 'ORDER_ADDED', table._id, { orderId: (order as any)._id?.toString(), orderNumber: (order as any).orderNumber, totalCents: (order as any).totalCents });
    try {
      const printResult = await this.printer.queueProductionOrder(actor.restaurantId, (order as any)._id.toString(), true);
      if (!(printResult as any)?.queued && (printResult as any)?.reason && (printResult as any)?.reason !== 'NO_PRINTABLE_ITEMS') {
        this.logger.warn(`Pedido ${(order as any).orderNumber || (order as any)._id} sem impressão automática: ${(printResult as any).reason}`);
      }
    } catch (error) {
      this.logger.error(`Falha ao enfileirar impressão automática do pedido ${(order as any).orderNumber || (order as any)._id}`, error instanceof Error ? error.stack : String(error));
    }
    return this.session(actor, session._id.toString());
  }

  async markOrderReady(actor: TableActor, sessionId: string, orderId: string, sector?: 'KITCHEN' | 'BAR') {
    await this.assertPermission(actor, 'TABLES_KITCHEN');
    const rid = this.rid(actor);
    const session = await this.activeSession(rid, sessionId);
    const order = await this.orders.findOne({ _id: this.oid(orderId, 'Pedido não encontrado.'), restaurantId: rid, tableSessionId: session._id, fulfillment: 'TABLE' });
    if (!order) throw new NotFoundException('Pedido de mesa não encontrado nesta comanda.');
    if (order.status === 'READY') return this.session(actor, sessionId);
    if (order.status !== 'PREPARING') throw new ConflictException('Somente pedidos em preparo podem ser marcados como prontos.');

    const states = (order.productionStates?.length ? order.productionStates : this.productionStatesFromItems(order.items as any[])).map((state: any) => ({
      sector: state.sector as 'KITCHEN' | 'BAR',
      status: state.status as 'PREPARING' | 'READY',
      readyAt: state.readyAt,
      readyBy: state.readyBy,
    }));
    if (!states.length) states.push({ sector: 'KITCHEN', status: 'PREPARING', readyAt: undefined, readyBy: undefined });
    const selected = sector ? states.filter((state) => state.sector === sector) : states.filter((state) => state.status !== 'READY');
    if (!selected.length && sector) throw new ConflictException('Este setor não possui itens neste pedido.');
    const now = new Date();
    const actorId = this.oid(actor.sub, 'Responsável inválido.');
    for (const state of states) {
      if ((!sector || state.sector === sector) && state.status !== 'READY') {
        state.status = 'READY';
        state.readyAt = now;
        state.readyBy = actorId;
      }
    }
    order.productionStates = states as any;
    await order.save();
    if (sector) {
      void this.printer.discardAutoProduction(order._id.toString(), sector).catch(() => undefined);
      await this.event(actor, session._id, 'ORDER_SECTOR_READY', order.tableId ?? session.primaryTableId, { orderId: order._id.toString(), orderNumber: order.orderNumber, sector });
    }

    if (states.every((state) => state.status === 'READY')) {
      await this.ordersService.updateStatus(actor.restaurantId, order._id.toString(), 'READY', actor.sub);
      void this.printer.discardAutoKitchen(order._id.toString()).catch(() => undefined);
      await this.event(actor, session._id, 'ORDER_READY', order.tableId ?? session.primaryTableId, { orderId: order._id.toString(), orderNumber: order.orderNumber });
    }
    return this.session(actor, sessionId);
  }

  async deliverOrder(actor: TableActor, sessionId: string, orderId: string) {
    await this.assertPermission(actor, 'TABLES_DELIVER');
    const rid = this.rid(actor);
    const session = await this.activeSession(rid, sessionId);
    const order = await this.orders.findOne({ _id: this.oid(orderId, 'Pedido não encontrado.'), restaurantId: rid, tableSessionId: session._id, fulfillment: 'TABLE' }).lean();
    if (!order) throw new NotFoundException('Pedido de mesa não encontrado nesta comanda.');
    if (order.status !== 'READY') throw new ConflictException('Somente pedidos prontos podem ser entregues na mesa.');
    await this.ordersService.updateStatus(actor.restaurantId, order._id.toString(), 'DELIVERED_TO_TABLE', actor.sub);
    await this.event(actor, session._id, 'ORDER_DELIVERED', order.tableId ?? session.primaryTableId, { orderId: order._id.toString(), orderNumber: order.orderNumber });
    return this.session(actor, sessionId);
  }

  async cancelOrder(actor: TableActor, sessionId: string, orderId: string, reason?: string) {
    await this.assertPermission(actor, 'TABLES_CANCEL');
    const rid = this.rid(actor);
    const session = await this.activeSession(rid, sessionId);
    const order = await this.orders.findOne({ _id: this.oid(orderId, 'Pedido não encontrado.'), restaurantId: rid, tableSessionId: session._id, fulfillment: 'TABLE' }).lean();
    if (!order) throw new NotFoundException('Pedido de mesa não encontrado nesta comanda.');
    if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(order.status)) throw new ConflictException('Este pedido já está finalizado.');
    if (session.paidCents > 0) throw new ConflictException('Não é possível cancelar itens depois de registrar pagamentos nesta conta. Revise os pedidos antes de iniciar o recebimento.');
    await this.ordersService.updateStatus(actor.restaurantId, order._id.toString(), 'CANCELLED', actor.sub, reason?.trim() || 'Cancelado pelo salão.');
    await this.recalculate(session._id);
    await this.event(actor, session._id, 'ORDER_CANCELLED', order.tableId ?? session.primaryTableId, { orderId: order._id.toString(), orderNumber: order.orderNumber, reason: reason?.trim() || 'Cancelado pelo salão.' });
    return this.session(actor, sessionId);
  }

  async requestBill(actor: TableActor, sessionId: string) {
    await this.assertPermission(actor, 'TABLES_REQUEST_BILL');
    const rid = this.rid(actor);
    const session = await this.activeSession(rid, sessionId);
    if (session.status === 'AWAITING_PAYMENT') return this.session(actor, sessionId);
    await this.recalculate(session._id);
    const billableOrders = await this.orders.countDocuments({ restaurantId: rid, tableSessionId: session._id, status: { $nin: ['REJECTED', 'CANCELLED'] } });
    const fresh = await this.sessions.findById(session._id);
    if (!fresh) throw new NotFoundException('Comanda não encontrada.');
    if (billableOrders === 0 || fresh.subtotalCents <= 0) throw new ConflictException('Adicione pelo menos um pedido à mesa antes de solicitar a conta.');
    fresh.status = 'AWAITING_PAYMENT';
    await fresh.save();
    const updatedSession = fresh;
    await this.event(actor, updatedSession._id, 'BILL_REQUESTED', updatedSession.primaryTableId, { totalCents: updatedSession.totalCents, balanceCents: updatedSession.balanceCents });
    const primaryTable = await this.tables.findById(updatedSession.primaryTableId).select('name').lean();
    void this.notifications.notifyTableBillRequested({
      restaurantId: actor.restaurantId,
      tableName: primaryTable?.name || 'Mesa',
      totalCents: updatedSession.totalCents,
    }).catch(() => undefined);
    try {
      await this.printer.queueBill(actor.restaurantId, updatedSession._id.toString(), true);
    } catch (error) {
      this.logger.error(`Falha ao enfileirar pré-conta automática da mesa ${primaryTable?.name || updatedSession._id}`, error instanceof Error ? error.stack : String(error));
    }
    return this.session(actor, sessionId);
  }

  async addPayment(actor: TableActor, sessionId: string, input: { amountCents: number; method: string; note?: string }) {
    await this.assertPermission(actor, 'TABLES_PAYMENT');
    const session = await this.activeSession(this.rid(actor), sessionId);
    if (session.status !== 'AWAITING_PAYMENT') throw new ConflictException('Solicite a conta antes de registrar pagamentos.');
    await this.recalculate(session._id);
    const fresh = await this.sessions.findById(session._id);
    if (!fresh) throw new NotFoundException('Comanda não encontrada.');
    await this.cashRegister.assertOpen(actor);
    const receivedCents = input.amountCents;
    const isCash = input.method === 'CASH';
    if (!isCash && receivedCents > fresh.balanceCents) throw new BadRequestException('O pagamento não pode ser maior que o saldo pendente.');
    const appliedCents = Math.min(receivedCents, fresh.balanceCents);
    const changeCents = isCash ? Math.max(0, receivedCents - fresh.balanceCents) : 0;
    const paymentNote = [
      input.note?.trim(),
      changeCents > 0 ? `Recebido ${this.money(receivedCents)} · Troco ${this.money(changeCents)}` : undefined,
    ].filter(Boolean).join(' · ') || undefined;
    fresh.payments = [...(fresh.payments ?? []), {
      amountCents: appliedCents,
      receivedCents: isCash ? receivedCents : undefined,
      changeCents: changeCents || undefined,
      method: input.method,
      recordedBy: this.oid(actor.sub, 'Responsável inválido.'),
      recordedAt: new Date(),
      note: paymentNote,
    }];
    fresh.paidCents = fresh.payments.reduce((sum, payment) => sum + Number(payment.amountCents || 0), 0);
    fresh.balanceCents = Math.max(0, fresh.totalCents - fresh.paidCents);
    await fresh.save();
    await this.cashRegister.recordSale(actor, {
      amountCents: appliedCents,
      method: input.method,
      sourceId: fresh._id.toString(),
      sourceKey: `TABLE_PAYMENT:${fresh._id.toString()}:${fresh.payments.length}`,
      note: `Comanda ${fresh._id.toString().slice(-6).toUpperCase()}${paymentNote ? ` · ${paymentNote}` : ''}`,
    });
    await this.event(actor, fresh._id, 'PAYMENT_ADDED', fresh.primaryTableId, { amountCents: appliedCents, receivedCents: isCash ? receivedCents : undefined, changeCents, method: input.method, balanceCents: fresh.balanceCents });
    return this.session(actor, sessionId);
  }

  async settleAndClose(actor: TableActor, sessionId: string, input: { method: string; receivedCents?: number }) {
    await this.assertPermission(actor, 'TABLES_PAYMENT');
    await this.assertPermission(actor, 'TABLES_CLOSE');
    const rid = this.rid(actor);
    const session = await this.activeSession(rid, sessionId);
    if (session.status !== 'AWAITING_PAYMENT') throw new ConflictException('Solicite a conta antes de fechar a mesa.');
    await this.recalculate(session._id);
    const fresh = await this.sessions.findById(session._id);
    if (!fresh) throw new NotFoundException('Comanda não encontrada.');
    const activeOrders = await this.orders.find({ restaurantId: rid, tableSessionId: fresh._id, status: { $in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY'] } }).select('orderNumber status').lean();
    if (activeOrders.length) throw new ConflictException('Ainda existem pedidos em preparo ou aguardando entrega. Entregue os pedidos antes de fechar a mesa.');

    if (fresh.balanceCents > 0) {
      await this.cashRegister.assertOpen(actor);
      const amountCents = fresh.balanceCents;
      if (input.method === 'CASH' && input.receivedCents != null && input.receivedCents < fresh.balanceCents) throw new BadRequestException('O valor recebido em dinheiro é menor que o saldo da conta.');
      const changeCents = input.method === 'CASH' && input.receivedCents ? Math.max(0, input.receivedCents - fresh.balanceCents) : 0;
      fresh.payments = [...(fresh.payments ?? []), {
        amountCents,
        method: input.method,
        recordedBy: this.oid(actor.sub, 'Responsável inválido.'),
        recordedAt: new Date(),
        note: changeCents > 0 ? `Recebido ${this.money(input.receivedCents!)} · Troco ${this.money(changeCents)}` : undefined,
      }];
      fresh.paidCents = fresh.payments.reduce((sum, payment) => sum + Number(payment.amountCents || 0), 0);
      fresh.balanceCents = 0;
      await fresh.save();
      await this.cashRegister.recordSale(actor, {
        amountCents,
        method: input.method,
        sourceId: fresh._id.toString(),
        sourceKey: `TABLE_PAYMENT:${fresh._id.toString()}:${fresh.payments.length}`,
        note: `Fechamento rápido · Comanda ${fresh._id.toString().slice(-6).toUpperCase()}`,
      });
      await this.event(actor, fresh._id, 'PAYMENT_ADDED', fresh.primaryTableId, { amountCents, method: input.method, balanceCents: 0, quickClose: true });
    }

    const delivered = await this.orders.find({ restaurantId: rid, tableSessionId: fresh._id, status: 'DELIVERED_TO_TABLE' }).select('_id').lean();
    for (const order of delivered) await this.ordersService.updateStatus(actor.restaurantId, order._id.toString(), 'COMPLETED', actor.sub);
    void this.printer.discardAutoBill(fresh._id.toString()).catch(() => undefined);
    fresh.status = 'CLOSED';
    fresh.active = false;
    fresh.closedAt = new Date();
    fresh.closedBy = this.oid(actor.sub, 'Responsável inválido.');
    await fresh.save();
    await this.event(actor, fresh._id, 'TABLE_CLOSED', fresh.primaryTableId, { totalCents: fresh.totalCents, paidCents: fresh.paidCents, quickClose: true });
    return this.session(actor, sessionId);
  }

  async setDiscount(actor: TableActor, sessionId: string, discountCents: number) {
    await this.assertPermission(actor, 'TABLES_DISCOUNT');
    const session = await this.activeSession(this.rid(actor), sessionId);
    await this.recalculate(session._id);
    const fresh = await this.sessions.findById(session._id);
    if (!fresh) throw new NotFoundException('Comanda não encontrada.');
    const beforeDiscount = fresh.subtotalCents + fresh.serviceFeeCents;
    const maximumDiscount = Math.max(0, beforeDiscount - fresh.paidCents);
    if (discountCents > maximumDiscount) throw new BadRequestException('O desconto não pode deixar o total menor que o valor já pago.');
    fresh.discountCents = discountCents;
    await fresh.save();
    await this.recalculate(fresh._id);
    const updated = await this.sessions.findById(fresh._id).lean();
    await this.event(actor, fresh._id, 'DISCOUNT_CHANGED', fresh.primaryTableId, { discountCents, totalCents: updated?.totalCents });
    return this.session(actor, sessionId);
  }


  async setServiceFee(actor: TableActor, sessionId: string, enabled: boolean) {
    await this.assertPermission(actor, 'TABLES_PAYMENT');
    const rid = this.rid(actor);
    const session = await this.activeSession(rid, sessionId);
    await this.recalculate(session._id);
    const fresh = await this.sessions.findById(session._id);
    if (!fresh) throw new NotFoundException('Comanda não encontrada.');

    const settings = await this.settings.findOne({ restaurantId: rid }).select('serviceFeePercent').lean();
    const configuredPercent = Math.max(0, Number(settings?.serviceFeePercent ?? 10));
    const nextPercent = enabled ? configuredPercent : 0;
    const nextServiceFeeCents = Math.round(Number(fresh.subtotalCents || 0) * nextPercent / 100);
    const nextBeforeDiscount = Number(fresh.subtotalCents || 0) + nextServiceFeeCents;
    const nextDiscount = Math.min(Math.max(0, Number(fresh.discountCents || 0)), nextBeforeDiscount);
    const nextTotalCents = nextBeforeDiscount - nextDiscount;
    const paidCents = (fresh.payments ?? []).reduce((sum, payment) => sum + Number(payment.amountCents || 0), 0);

    if (!enabled && paidCents > nextTotalCents) {
      throw new ConflictException('Não é possível remover a taxa de serviço porque o valor já pago ficaria maior que o novo total da conta. Ajuste os pagamentos antes.');
    }

    const previousPercent = Number(fresh.serviceFeePercent || 0);
    fresh.serviceFeePercent = nextPercent;
    await fresh.save();
    await this.recalculate(fresh._id);
    const updated = await this.sessions.findById(fresh._id).lean();
    await this.event(actor, fresh._id, 'SERVICE_FEE_CHANGED', fresh.primaryTableId, {
      enabled,
      previousPercent,
      serviceFeePercent: nextPercent,
      serviceFeeCents: updated?.serviceFeeCents ?? 0,
      totalCents: updated?.totalCents ?? 0,
    });
    return this.session(actor, sessionId);
  }

  async changeWaiter(actor: TableActor, sessionId: string, waiterId: string) {
    await this.assertPermission(actor, 'TABLES_TRANSFER');
    const rid = this.rid(actor);
    const session = await this.activeSession(rid, sessionId);
    const waiter = await this.validWaiter(rid, waiterId);
    const previous = session.waiterId?.toString();
    session.waiterId = waiter;
    await session.save();
    await this.orders.updateMany({ restaurantId: rid, tableSessionId: session._id, status: { $nin: ['COMPLETED', 'REJECTED', 'CANCELLED'] } }, { $set: { waiterId: waiter } });
    await this.event(actor, session._id, 'WAITER_CHANGED', session.primaryTableId, { previousWaiterId: previous, waiterId });
    return this.session(actor, sessionId);
  }

  async transfer(actor: TableActor, sessionId: string, fromTableId: string, toTableId: string) {
    await this.assertPermission(actor, 'TABLES_TRANSFER');
    const rid = this.rid(actor);
    const session = await this.activeSession(rid, sessionId);
    const from = this.oid(fromTableId, 'Mesa de origem inválida.');
    const to = this.oid(toTableId, 'Mesa de destino inválida.');
    if (!session.tableIds.some((id) => id.toString() === from.toString())) throw new BadRequestException('A mesa de origem não pertence a esta comanda.');
    const target = await this.tables.findOne({ _id: to, restaurantId: rid, active: true }).lean();
    if (!target) throw new NotFoundException('Mesa de destino não encontrada.');
    if (await this.sessions.exists({ _id: { $ne: session._id }, restaurantId: rid, tableIds: to, status: { $ne: 'CLOSED' } })) throw new ConflictException('A mesa de destino já está ocupada.');
    session.tableIds = session.tableIds.map((id) => id.toString() === from.toString() ? to : id);
    if (session.primaryTableId.toString() === from.toString()) session.primaryTableId = to;
    try { await session.save(); }
    catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException('A mesa de destino acabou de ser ocupada por outra comanda. Atualize a tela.');
      throw error;
    }
    await this.orders.updateMany({ restaurantId: rid, tableSessionId: session._id, tableId: from }, { $set: { tableId: to } });
    await this.event(actor, session._id, 'TABLE_TRANSFERRED', to, { fromTableId, toTableId });
    return this.session(actor, sessionId);
  }

  async merge(actor: TableActor, sessionId: string, tableIds: string[]) {
    await this.assertPermission(actor, 'TABLES_TRANSFER');
    const rid = this.rid(actor);
    const session = await this.activeSession(rid, sessionId);
    const ids = [...new Set(tableIds)].map((id) => this.oid(id, 'Mesa inválida.'));
    const owned = await this.tables.find({ _id: { $in: ids }, restaurantId: rid, active: true }).select('_id').lean();
    if (owned.length !== ids.length) throw new NotFoundException('Uma ou mais mesas não foram encontradas.');
    if (await this.sessions.exists({ _id: { $ne: session._id }, restaurantId: rid, tableIds: { $in: ids }, status: { $ne: 'CLOSED' } })) throw new ConflictException('Uma das mesas já está ocupada.');
    const current = new Set(session.tableIds.map((id) => id.toString()));
    for (const id of ids) current.add(id.toString());
    session.tableIds = [...current].map((id) => new Types.ObjectId(id));
    try { await session.save(); }
    catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException('Uma das mesas acabou de ser ocupada por outra comanda. Atualize a tela.');
      throw error;
    }
    await this.event(actor, session._id, 'TABLES_MERGED', session.primaryTableId, { tableIds: ids.map((id) => id.toString()) });
    return this.session(actor, sessionId);
  }

  async close(actor: TableActor, sessionId: string) {
    await this.assertPermission(actor, 'TABLES_CLOSE');
    const rid = this.rid(actor);
    const session = await this.activeSession(rid, sessionId);
    await this.recalculate(session._id);
    const fresh = await this.sessions.findById(session._id);
    if (!fresh) throw new NotFoundException('Comanda não encontrada.');
    if (fresh.balanceCents !== 0) throw new ConflictException('Ainda existe saldo pendente nesta mesa.');
    const activeOrders = await this.orders.find({ restaurantId: rid, tableSessionId: fresh._id, status: { $in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY'] } }).select('orderNumber status').lean();
    if (activeOrders.length) throw new ConflictException('Existem pedidos que ainda não foram entregues na mesa.');
    const delivered = await this.orders.find({ restaurantId: rid, tableSessionId: fresh._id, status: 'DELIVERED_TO_TABLE' }).select('_id').lean();
    for (const order of delivered) await this.ordersService.updateStatus(actor.restaurantId, order._id.toString(), 'COMPLETED', actor.sub);
    void this.printer.discardAutoBill(fresh._id.toString()).catch(() => undefined);
    fresh.status = 'CLOSED';
    fresh.active = false;
    fresh.closedAt = new Date();
    fresh.closedBy = this.oid(actor.sub, 'Responsável inválido.');
    await fresh.save();
    await this.event(actor, fresh._id, 'TABLE_CLOSED', fresh.primaryTableId, { totalCents: fresh.totalCents, paidCents: fresh.paidCents });
    return this.session(actor, sessionId);
  }

  private async recalculate(sessionId: Types.ObjectId) {
    const session = await this.sessions.findById(sessionId);
    if (!session) throw new NotFoundException('Comanda não encontrada.');
    const orders = await this.orders.find({ tableSessionId: session._id, status: { $nin: ['REJECTED', 'CANCELLED'] } }).select('totalCents').lean();
    const subtotalCents = orders.reduce((sum, order) => sum + Number(order.totalCents || 0), 0);
    const serviceFeeCents = Math.round(subtotalCents * (session.serviceFeePercent || 0) / 100);
    const beforeDiscount = subtotalCents + serviceFeeCents;
    const discountCents = Math.min(Math.max(0, session.discountCents || 0), beforeDiscount);
    const totalCents = beforeDiscount - discountCents;
    const paidCents = (session.payments ?? []).reduce((sum, payment) => sum + Number(payment.amountCents || 0), 0);
    session.subtotalCents = subtotalCents;
    session.serviceFeeCents = serviceFeeCents;
    session.discountCents = discountCents;
    session.totalCents = totalCents;
    session.paidCents = paidCents;
    session.balanceCents = Math.max(0, totalCents - paidCents);
    await session.save();
    return session;
  }

  private async activeSession(rid: Types.ObjectId, sessionId: string) {
    const session = await this.sessions.findOne({ _id: this.oid(sessionId, 'Comanda não encontrada.'), restaurantId: rid, status: { $ne: 'CLOSED' } });
    if (!session) throw new NotFoundException('Comanda aberta não encontrada.');
    return session;
  }

  private async assertEnabled(rid: Types.ObjectId) {
    const settings = await this.settings.findOne({ restaurantId: rid }).select('tableServiceEnabled waiterAppEnabled').lean();
    if (!settings?.tableServiceEnabled) throw new ForbiddenException('O controle de mesas não está habilitado para este estabelecimento.');
  }

  private async assertPermission(actor: TableActor, permission: TablePermission) {
    if (actor.role === Role.RESTAURANT_ADMIN || actor.role === Role.SUPER_ADMIN) return;
    if (actor.role !== Role.EMPLOYEE) throw new ForbiddenException('Acesso não autorizado.');
    const rid = this.rid(actor);
    const [employee, settings] = await Promise.all([
      this.users.findOne({ _id: this.oid(actor.sub, 'Funcionário inválido.'), restaurantId: rid, role: Role.EMPLOYEE, active: true, deletedAt: null }).select('permissions employeePosition').lean(),
      this.settings.findOne({ restaurantId: rid }).select('tableServiceEnabled waiterAppEnabled').lean(),
    ]);
    if (!settings?.tableServiceEnabled || !settings?.waiterAppEnabled) throw new ForbiddenException('O app do garçom não está habilitado para este estabelecimento.');
    const implied = ['KITCHEN','BAR'].includes(employee?.employeePosition ?? '') && ['TABLES_VIEW','TABLES_KITCHEN','TABLES_PRINT'].includes(permission)
      || employee?.employeePosition === 'CASHIER' && ['TABLES_VIEW','TABLES_PAYMENT','TABLES_PRINT','TABLES_CLOSE'].includes(permission);
    if (!employee || (!(employee.permissions ?? []).includes(permission) && !implied)) throw new ForbiddenException('Seu usuário não possui permissão para esta ação no salão.');
  }

  private assertOwner(actor: TableActor) {
    if (actor.role !== Role.RESTAURANT_ADMIN && actor.role !== Role.SUPER_ADMIN) throw new ForbiddenException('Somente o lojista pode gerenciar o cadastro de mesas.');
  }

  private async validWaiter(rid: Types.ObjectId, waiterId: string) {
    const id = this.oid(waiterId, 'Garçom inválido.');
    const waiter = await this.users.findOne({ _id: id, restaurantId: rid, role: Role.EMPLOYEE, active: true, deletedAt: null, permissions: 'TABLES_VIEW' }).select('_id employeePosition permissions').lean();
    if (!waiter) throw new NotFoundException('Garçom não encontrado neste estabelecimento.');
    return id;
  }

  private productionStatesFromItems(items: any[]) {
    const sectors = [...new Set((items ?? []).map((item) => item.productionSector ?? 'KITCHEN').filter((value) => value === 'KITCHEN' || value === 'BAR'))] as Array<'KITCHEN' | 'BAR'>;
    return sectors.map((sector) => ({ sector, status: 'PREPARING' as const }));
  }

  private money(cents: number) {
    return `R$ ${(Number(cents || 0) / 100).toFixed(2).replace('.', ',')}`;
  }

  private event(actor: TableActor, sessionId: Types.ObjectId, action: string, tableId?: Types.ObjectId, metadata: Record<string, unknown> = {}) {
    return this.tableEvents.create({ restaurantId: this.rid(actor), tableSessionId: sessionId, tableId, actorId: this.oid(actor.sub, 'Responsável inválido.'), action, metadata });
  }

  private rid(actor: TableActor) {
    return this.oid(actor.restaurantId, 'Estabelecimento inválido.');
  }

  private oid(value: string, message: string) {
    if (!Types.ObjectId.isValid(value)) throw new BadRequestException(message);
    return new Types.ObjectId(value);
  }
}
