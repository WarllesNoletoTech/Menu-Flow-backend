import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { Role } from '../common/roles';
import { Order, PrintJob, Restaurant, RestaurantSettings, RestaurantTable, TableSession, User } from '../common/schemas';

export type PrinterActor = { sub: string; role: Role; restaurantId: string };
type PrinterRole = 'KITCHEN' | 'CASHIER' | 'BAR';

@Injectable()
export class PrinterService {
  constructor(
    @InjectModel(PrintJob.name) private readonly jobs: Model<PrintJob>,
    @InjectModel(RestaurantSettings.name) private readonly settings: Model<RestaurantSettings>,
    @InjectModel(Restaurant.name) private readonly restaurants: Model<Restaurant>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(TableSession.name) private readonly sessions: Model<TableSession>,
    @InjectModel(RestaurantTable.name) private readonly tables: Model<RestaurantTable>,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  async getSettings(actor: PrinterActor) {
    await this.assertView(actor);
    const setting = await this.settings.findOne({ restaurantId: this.rid(actor) }).lean();
    return this.publicSettings(setting);
  }

  async updateSettings(actor: PrinterActor, input: { printerEnabled?: boolean; printerAutoKitchen?: boolean; printerAutoBill?: boolean; printerPaperWidth?: 58 | 80 }) {
    this.assertOwner(actor);
    const setting = await this.settings.findOneAndUpdate(
      { restaurantId: this.rid(actor) },
      { $set: input, $setOnInsert: { restaurantId: this.rid(actor) } },
      { new: true, upsert: true, runValidators: true },
    ).lean();
    return this.publicSettings(setting);
  }

  async rotateToken(actor: PrinterActor) {
    this.assertOwner(actor);
    const token = `mfpr_${randomBytes(32).toString('base64url')}`;
    const hash = this.hashToken(token);
    const last4 = token.slice(-4);
    await this.settings.findOneAndUpdate(
      { restaurantId: this.rid(actor) },
      { $set: { printerEnabled: true, printerTokenHash: hash, printerTokenLast4: last4 }, $setOnInsert: { restaurantId: this.rid(actor) } },
      { upsert: true },
    );
    return { token, last4 };
  }

  async queueOrderForActor(actor: PrinterActor, orderId: string) {
    await this.assertPrint(actor);
    return this.queueProductionOrder(actor.restaurantId, orderId, false);
  }

  async queueOrderSectorForActor(actor: PrinterActor, orderId: string, sectorValue: string) {
    await this.assertPrint(actor);
    const sector = sectorValue.toUpperCase();
    if (sector !== 'KITCHEN' && sector !== 'BAR') throw new BadRequestException('Setor de impressão inválido.');
    const rid = this.rid(actor);
    const setting = await this.settings.findOne({ restaurantId: rid }).lean();
    if (!setting?.printerEnabled) return { queued: false, reason: 'PRINTER_DISABLED' };
    const order = await this.orders.findOne({ _id: this.oid(orderId, 'Pedido não encontrado.'), restaurantId: rid, fulfillment: 'TABLE' }).lean();
    if (!order) throw new NotFoundException('Pedido de mesa não encontrado.');
    const items = (order.items || []).filter((item: any) => (item.productionSector ?? 'KITCHEN') === sector);
    if (!items.length) return { queued: false, reason: 'NO_PRINTABLE_ITEMS' };
    const content = await this.productionContent(rid, order, sector, items, setting.printerPaperWidth ?? 80);
    const job = await this.createJob({ restaurantId: rid, printerRole: sector, type: sector === 'BAR' ? 'BAR_ORDER' : 'KITCHEN_ORDER', content, payload: { orderId: order._id.toString(), orderNumber: order.orderNumber, tableSessionId: order.tableSessionId?.toString(), sector } });
    return { queued: true, jobId: job._id.toString(), sector };
  }

  async queueBillForActor(actor: PrinterActor, sessionId: string) {
    await this.assertPrint(actor);
    return this.queueBill(actor.restaurantId, sessionId, false);
  }

  async queueKitchenOrder(restaurantId: string, orderId: string, automatic = true) {
    return this.queueProductionOrder(restaurantId, orderId, automatic);
  }

  async queueProductionOrder(restaurantId: string, orderId: string, automatic = true) {
    const rid = this.oid(restaurantId, 'Estabelecimento inválido.');
    const setting = await this.settings.findOne({ restaurantId: rid }).lean();
    if (!setting?.printerEnabled) return { queued: false, reason: 'PRINTER_DISABLED', jobs: [] };
    if (automatic && !setting.printerAutoKitchen) return { queued: false, reason: 'AUTO_DISABLED', jobs: [] };
    const order = await this.orders.findOne({ _id: this.oid(orderId, 'Pedido não encontrado.'), restaurantId: rid, fulfillment: 'TABLE' }).lean();
    if (!order) throw new NotFoundException('Pedido de mesa não encontrado.');

    const sectors: Array<'KITCHEN' | 'BAR'> = ['KITCHEN', 'BAR'];
    const jobs: Array<{ sector: 'KITCHEN' | 'BAR'; jobId: string }> = [];
    for (const sector of sectors) {
      const items = (order.items || []).filter((item: any) => (item.productionSector ?? 'KITCHEN') === sector);
      if (!items.length) continue;
      const content = await this.productionContent(rid, order, sector, items, setting.printerPaperWidth ?? 80);
      const sourceKey = automatic ? `AUTO:PRODUCTION:${order._id.toString()}:${sector}` : undefined;
      const job = await this.createJob({
        restaurantId: rid,
        printerRole: sector,
        type: sector === 'BAR' ? 'BAR_ORDER' : 'KITCHEN_ORDER',
        content,
        sourceKey,
        payload: { orderId: order._id.toString(), orderNumber: order.orderNumber, tableSessionId: order.tableSessionId?.toString(), sector },
      });
      jobs.push({ sector, jobId: job._id.toString() });
    }
    return jobs.length ? { queued: true, jobs } : { queued: false, reason: 'NO_PRINTABLE_ITEMS', jobs: [] };
  }

  async queueBill(restaurantId: string, sessionId: string, automatic = true) {
    const rid = this.oid(restaurantId, 'Estabelecimento inválido.');
    const setting = await this.settings.findOne({ restaurantId: rid }).lean();
    if (!setting?.printerEnabled) return { queued: false, reason: 'PRINTER_DISABLED' };
    if (automatic && !setting.printerAutoBill) return { queued: false, reason: 'AUTO_DISABLED' };
    const session = await this.sessions.findOne({ _id: this.oid(sessionId, 'Comanda não encontrada.'), restaurantId: rid }).lean();
    if (!session) throw new NotFoundException('Comanda não encontrada.');
    const content = await this.billContent(rid, session, setting.printerPaperWidth ?? 80);
    const sourceKey = automatic ? `AUTO:BILL:${session._id.toString()}` : undefined;
    const job = await this.createJob({ restaurantId: rid, printerRole: 'CASHIER', type: 'PRE_BILL', content, sourceKey, payload: { tableSessionId: session._id.toString(), totalCents: session.totalCents, balanceCents: session.balanceCents } });
    return { queued: true, jobId: job._id.toString() };
  }

  async recent(actor: PrinterActor) {
    await this.assertView(actor);
    return this.jobs.find({ restaurantId: this.rid(actor) }).sort({ createdAt: -1 }).limit(30).select('printerRole type status attempts error createdAt printedAt').lean();
  }

  async discardAutoKitchen(orderId: string) {
    return this.discardAutoProduction(orderId);
  }

  async discardAutoProduction(orderId: string, sector?: 'KITCHEN' | 'BAR') {
    const keys = sector
      ? [`AUTO:PRODUCTION:${orderId}:${sector}`]
      : [`AUTO:PRODUCTION:${orderId}:KITCHEN`, `AUTO:PRODUCTION:${orderId}:BAR`, `AUTO:KITCHEN:${orderId}`];
    await this.jobs.updateMany(
      { sourceKey: { $in: keys }, status: 'PENDING' },
      { $set: { status: 'FAILED', failedAt: new Date(), error: 'Setor avançou antes da impressão automática; trabalho descartado para evitar impressão atrasada.' } },
    );
  }

  async discardAutoBill(sessionId: string) {
    await this.jobs.updateMany(
      { sourceKey: `AUTO:BILL:${sessionId}`, status: 'PENDING' },
      { $set: { status: 'FAILED', failedAt: new Date(), error: 'Conta encerrada antes da impressão automática; trabalho descartado.' } },
    );
  }

  async claim(token: string | undefined, input: { deviceId: string; deviceName?: string; roles?: PrinterRole[] }) {
    const setting = await this.authenticateAgent(token);
    const roles = (input.roles?.length ? input.roles : ['KITCHEN', 'BAR', 'CASHIER']) as PrinterRole[];
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 45_000);
    const job = await this.jobs.findOneAndUpdate(
      {
        restaurantId: setting.restaurantId,
        printerRole: { $in: roles },
        attempts: { $lt: 6 },
        createdAt: { $gte: new Date(now.getTime() - 12 * 60 * 60 * 1000) },
        $or: [
          { status: 'PENDING' },
          { status: 'CLAIMED', leaseUntil: { $lt: now } },
        ],
      },
      {
        $set: { status: 'CLAIMED', claimedBy: input.deviceId, claimedAt: now, leaseUntil, error: undefined },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { createdAt: 1 } },
    ).lean();
    await this.settings.updateOne(
      { _id: (setting as any)._id },
      { $set: { printerLastSeenAt: now, printerDeviceName: input.deviceName?.trim() || input.deviceId } },
    );
    return job ? { job: { id: job._id.toString(), printerRole: job.printerRole, type: job.type, content: job.content, copies: job.copies, attempts: job.attempts } } : { job: null };
  }

  async acknowledge(token: string | undefined, jobId: string, input: { deviceId: string; success: boolean; error?: string }) {
    const setting = await this.authenticateAgent(token);
    const jid = this.oid(jobId, 'Trabalho de impressão inválido.');
    const job = await this.jobs.findOne({ _id: jid, restaurantId: setting.restaurantId });
    if (!job) throw new NotFoundException('Trabalho de impressão não encontrado.');
    if (job.claimedBy && job.claimedBy !== input.deviceId) throw new ForbiddenException('Este trabalho foi reservado por outro Menu Flow Printer.');
    const now = new Date();
    if (input.success) {
      job.status = 'PRINTED';
      job.printedAt = now;
      job.error = undefined;
    } else if (job.attempts >= 5) {
      job.status = 'FAILED';
      job.failedAt = now;
      job.error = input.error?.slice(0, 1000) || 'Falha de impressão sem detalhes.';
    } else {
      job.status = 'PENDING';
      job.error = input.error?.slice(0, 1000) || 'Falha temporária de impressão.';
    }
    job.leaseUntil = undefined;
    await job.save();
    return { ok: true, status: job.status };
  }

  private async createJob(input: { restaurantId: Types.ObjectId; printerRole: PrinterRole; type: string; content: string; payload: Record<string, unknown>; sourceKey?: string }) {
    if (input.sourceKey) {
      const existing = await this.jobs.findOne({ sourceKey: input.sourceKey }).lean();
      if (existing) return existing as any;
    }
    try {
      return await this.jobs.create({ ...input, status: 'PENDING', copies: 1, attempts: 0 });
    } catch (error) {
      if ((error as { code?: number }).code === 11000 && input.sourceKey) {
        const existing = await this.jobs.findOne({ sourceKey: input.sourceKey }).lean();
        if (existing) return existing as any;
      }
      throw error;
    }
  }

  private async productionContent(rid: Types.ObjectId, order: any, sector: 'KITCHEN' | 'BAR', items: any[], paper: 58 | 80) {
    const [restaurant, waiter, table] = await Promise.all([
      this.restaurants.findById(rid).select('name tradeName').lean(),
      order.waiterId ? this.users.findById(order.waiterId).select('name').lean() : null,
      order.tableId ? this.tables.findById(order.tableId).select('name').lean() : null,
    ]);
    const w = paper === 58 ? 32 : 48;
    const lines: string[] = [];
    lines.push(this.center(restaurant?.tradeName || restaurant?.name || 'MENU FLOW', w));
    lines.push(this.center(sector === 'BAR' ? 'PEDIDO - BAR' : 'PEDIDO - COZINHA', w), this.hr(w));
    lines.push(`${table?.name || order.customerName || 'MESA'}   ${order.orderNumber || ''}`.trim());
    if (waiter?.name) lines.push(`Garcom: ${waiter.name}`);
    lines.push(`Hora: ${new Date(order.createdAt || Date.now()).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    lines.push(this.hr(w));
    for (const item of items) {
      lines.push(...this.wrap(`${item.quantity}x ${item.productName}`, w));
      for (const addon of item.addons || []) lines.push(...this.wrap(`  + ${addon.name}`, w));
      if (item.observation) lines.push(...this.wrap(`  OBS: ${String(item.observation).toUpperCase()}`, w));
    }
    lines.push(this.hr(w), this.center(sector === 'BAR' ? 'BAR' : 'COZINHA', w), '', '');
    return lines.join('\n');
  }

  private async billContent(rid: Types.ObjectId, session: any, paper: 58 | 80) {
    const [restaurant, tables, orders, waiter] = await Promise.all([
      this.restaurants.findById(rid).select('name tradeName').lean(),
      this.tables.find({ _id: { $in: session.tableIds || [] } }).select('name').lean(),
      this.orders.find({ restaurantId: rid, tableSessionId: session._id, status: { $nin: ['REJECTED', 'CANCELLED'] } }).sort({ createdAt: 1 }).lean(),
      session.waiterId ? this.users.findById(session.waiterId).select('name').lean() : null,
    ]);
    const w = paper === 58 ? 32 : 48;
    const lines: string[] = [];
    lines.push(this.center(restaurant?.tradeName || restaurant?.name || 'MENU FLOW', w));
    lines.push(this.center('PRE-CONTA', w), this.hr(w));
    lines.push(`Mesa: ${tables.map((t) => t.name).join(' + ') || 'Mesa'}`);
    if (waiter?.name) lines.push(`Garcom: ${waiter.name}`);
    if (session.peopleCount) lines.push(`Pessoas: ${session.peopleCount}`);
    lines.push(this.hr(w));
    for (const order of orders) {
      for (const item of order.items || []) {
        const total = Number(item.quantity || 0) * (Number(item.unitPriceCents || 0) + (item.addons || []).reduce((sum: number, addon: any) => sum + Number(addon.priceCents || 0), 0));
        lines.push(...this.itemLine(`${item.quantity}x ${item.productName}`, this.money(total), w));
        for (const addon of item.addons || []) lines.push(...this.wrap(`  + ${addon.name}`, w));
      }
    }
    lines.push(this.hr(w));
    lines.push(...this.itemLine('Subtotal', this.money(session.subtotalCents), w));
    if (session.serviceFeeCents) lines.push(...this.itemLine(`Servico ${session.serviceFeePercent}%`, this.money(session.serviceFeeCents), w));
    if (session.discountCents) lines.push(...this.itemLine('Desconto', `-${this.money(session.discountCents)}`, w));
    lines.push(this.hr(w));
    lines.push(...this.itemLine('TOTAL', this.money(session.totalCents), w));
    if (session.paidCents) lines.push(...this.itemLine('Pago', this.money(session.paidCents), w));
    lines.push(...this.itemLine('Saldo', this.money(session.balanceCents), w));
    lines.push(this.hr(w), this.center('Esta nao e uma nota fiscal.', w), this.center('MENU FLOW', w), '', '');
    return lines.join('\n');
  }

  private publicSettings(setting: any) {
    return {
      printerEnabled: setting?.printerEnabled ?? false,
      printerAutoKitchen: setting?.printerAutoKitchen ?? true,
      printerAutoBill: setting?.printerAutoBill ?? false,
      printerPaperWidth: setting?.printerPaperWidth ?? 80,
      printerTokenLast4: setting?.printerTokenLast4 ?? null,
      printerLastSeenAt: setting?.printerLastSeenAt ?? null,
      printerDeviceName: setting?.printerDeviceName ?? null,
      connected: Boolean(setting?.printerLastSeenAt && Date.now() - new Date(setting.printerLastSeenAt).getTime() < 60_000),
    };
  }

  private async authenticateAgent(token?: string) {
    if (!token?.startsWith('mfpr_')) throw new UnauthorizedException('Token do Menu Flow Printer ausente ou inválido.');
    const hash = this.hashToken(token);
    const setting = await this.settings.findOne({ printerTokenHash: hash, printerEnabled: true }).lean();
    if (!setting) throw new UnauthorizedException('Menu Flow Printer não autorizado. Gere uma nova chave no painel.');
    return setting;
  }

  private hashToken(token: string) { return createHash('sha256').update(token).digest('hex'); }
  private rid(actor: PrinterActor) { return this.oid(actor.restaurantId, 'Estabelecimento inválido.'); }
  private oid(value: string, message: string) { if (!Types.ObjectId.isValid(value)) throw new BadRequestException(message); return new Types.ObjectId(value); }
  private assertOwner(actor: PrinterActor) { if (actor.role !== Role.RESTAURANT_ADMIN) throw new ForbiddenException('Somente o lojista pode alterar as configurações do Menu Flow Printer.'); }
  private async assertView(actor: PrinterActor) { if (actor.role === Role.RESTAURANT_ADMIN) return; const employee = await this.users.findOne({ _id: this.oid(actor.sub, 'Usuário inválido.'), restaurantId: this.rid(actor), role: Role.EMPLOYEE, active: true, deletedAt: null }).select('permissions employeePosition').lean(); const implied = ['KITCHEN','BAR','CASHIER'].includes(employee?.employeePosition ?? ''); if (!employee || (!(employee.permissions ?? []).includes('TABLES_VIEW') && !implied)) throw new ForbiddenException('Sem acesso à operação do salão.'); }
  private async assertPrint(actor: PrinterActor) { if (actor.role === Role.RESTAURANT_ADMIN) return; const employee = await this.users.findOne({ _id: this.oid(actor.sub, 'Usuário inválido.'), restaurantId: this.rid(actor), role: Role.EMPLOYEE, active: true, deletedAt: null }).select('permissions employeePosition').lean(); const implied = ['KITCHEN','BAR','CASHIER'].includes(employee?.employeePosition ?? ''); if (!employee || (!(employee.permissions ?? []).includes('TABLES_PRINT') && !implied)) throw new ForbiddenException('Seu usuário não possui permissão para imprimir.'); }
  private money(cents: number) { return `R$ ${(Number(cents || 0) / 100).toFixed(2).replace('.', ',')}`; }
  private hr(w: number) { return '-'.repeat(w); }
  private center(value: string, w: number) { const clean = value.slice(0, w); const left = Math.max(0, Math.floor((w - clean.length) / 2)); return `${' '.repeat(left)}${clean}`; }
  private wrap(value: string, w: number) { const words = String(value).trim().split(/\s+/); const lines: string[] = []; let line = ''; for (const word of words) { if (!line) line = word; else if (`${line} ${word}`.length <= w) line += ` ${word}`; else { lines.push(line); line = word; } } if (line) lines.push(line); return lines.length ? lines : ['']; }
  private itemLine(label: string, value: string, w: number) { const maxLabel = Math.max(8, w - value.length - 1); const labels = this.wrap(label, maxLabel); const result = labels.slice(0, -1); const last = labels.at(-1) || ''; result.push(`${last}${' '.repeat(Math.max(1, w - last.length - value.length))}${value}`); return result; }
}
