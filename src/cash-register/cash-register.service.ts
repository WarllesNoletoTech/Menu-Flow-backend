import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Role } from '../common/roles';
import { CashMovement, CashRegisterShift, Restaurant, User } from '../common/schemas';
import { PrinterService } from '../printer/printer.service';

export type CashActor = { sub: string; role: Role; restaurantId: string };
type PaymentMethod = 'PIX' | 'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD';

@Injectable()
export class CashRegisterService {
  private readonly logger = new Logger(CashRegisterService.name);
  constructor(
    @InjectModel(CashRegisterShift.name) private readonly shifts: Model<CashRegisterShift>,
    @InjectModel(CashMovement.name) private readonly movements: Model<CashMovement>,
    @InjectModel(Restaurant.name) private readonly restaurants: Model<Restaurant>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly printer: PrinterService,
  ) {}

  async current(actor: CashActor) {
    await this.assertAccess(actor);
    const rid = this.rid(actor);
    const shift = await this.shifts.findOne({ restaurantId: rid, status: 'OPEN' })
      .populate('openedBy', 'name')
      .populate('closedBy', 'name')
      .lean();

    if (shift) return this.contextForShift(rid, shift as any);

    const lastClosed = await this.shifts.findOne({ restaurantId: rid, status: 'CLOSED' })
      .sort({ closedAt: -1, openedAt: -1 })
      .populate('openedBy', 'name')
      .populate('closedBy', 'name')
      .lean();

    return {
      shift: null,
      summary: this.emptySummary(),
      movements: [],
      lastClosed: lastClosed ? await this.closedPreview(rid, lastClosed as any) : null,
    };
  }

  async open(actor: CashActor, input: { openingAmountCents: number; note?: string }) {
    await this.assertAccess(actor);
    const rid = this.rid(actor);
    if (input.openingAmountCents < 0) throw new BadRequestException('O valor inicial do caixa não pode ser negativo.');
    if (await this.shifts.exists({ restaurantId: rid, status: 'OPEN' })) throw new ConflictException('Já existe um caixa aberto neste estabelecimento.');

    let shift: any;
    try {
      shift = await this.shifts.create({
        restaurantId: rid,
        status: 'OPEN',
        openedBy: this.uid(actor),
        openingAmountCents: input.openingAmountCents,
        openedAt: new Date(),
        note: input.note?.trim() || undefined,
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException('Já existe um caixa aberto neste estabelecimento.');
      throw error;
    }

    const openingMovement = await this.movements.create({
      restaurantId: rid,
      shiftId: shift._id,
      type: 'OPENING',
      amountCents: input.openingAmountCents,
      method: 'CASH',
      recordedBy: this.uid(actor),
      recordedAt: new Date(),
      note: input.note?.trim() || 'Abertura do caixa',
      sourceType: 'CASH_OPEN',
      sourceId: shift._id.toString(),
      sourceKey: `CASH_OPEN:${shift._id.toString()}`,
    });

    await this.autoPrintCash(actor, 'OPEN', openingMovement._id.toString());
    const populated = await this.shifts.findById(shift._id).populate('openedBy', 'name').lean();
    return this.contextForShift(rid, populated as any);
  }

  async supply(actor: CashActor, input: { amountCents: number; note?: string }) {
    await this.assertAccess(actor);
    if (input.amountCents <= 0) throw new BadRequestException('Informe um valor de suprimento maior que zero.');
    const shift = await this.openShift(actor);
    const movement = await this.movements.create({
      restaurantId: this.rid(actor), shiftId: shift._id, type: 'SUPPLY', amountCents: input.amountCents, method: 'CASH',
      recordedBy: this.uid(actor), recordedAt: new Date(), note: input.note?.trim() || 'Suprimento de caixa', sourceType: 'MANUAL_SUPPLY',
    });
    await this.autoPrintCash(actor, 'SUPPLY', movement._id.toString());
    return this.contextForShift(this.rid(actor), shift as any);
  }

  async withdrawal(actor: CashActor, input: { amountCents: number; note?: string }) {
    await this.assertAccess(actor);
    if (input.amountCents <= 0) throw new BadRequestException('Informe um valor de sangria maior que zero.');
    const shift = await this.openShift(actor);
    const summary = await this.summaryForShift(shift._id);
    if (input.amountCents > summary.expectedCashCents) throw new BadRequestException('A sangria não pode ser maior que o dinheiro esperado no caixa.');
    const movement = await this.movements.create({
      restaurantId: this.rid(actor), shiftId: shift._id, type: 'WITHDRAWAL', amountCents: input.amountCents, method: 'CASH',
      recordedBy: this.uid(actor), recordedAt: new Date(), note: input.note?.trim() || 'Sangria de caixa', sourceType: 'MANUAL_WITHDRAWAL',
    });
    await this.autoPrintCash(actor, 'WITHDRAWAL', movement._id.toString());
    return this.contextForShift(this.rid(actor), shift as any);
  }

  async close(actor: CashActor, input: { declaredCashCents?: number; note?: string }) {
    await this.assertAccess(actor);
    const rid = this.rid(actor);
    const shift = await this.openShift(actor);
    const summary = await this.summaryForShift(shift._id);
    const declared = input.declaredCashCents == null ? summary.expectedCashCents : input.declaredCashCents;
    if (declared < 0) throw new BadRequestException('O valor conferido não pode ser negativo.');
    const difference = declared - summary.expectedCashCents;

    const closed = await this.shifts.findOneAndUpdate(
      { _id: shift._id, restaurantId: rid, status: 'OPEN' },
      { $set: { status: 'CLOSED', closedAt: new Date(), closedBy: this.uid(actor), declaredCashCents: declared, expectedCashCents: summary.expectedCashCents, differenceCents: difference, note: input.note?.trim() || shift.note } },
      { new: true, runValidators: true },
    ).populate('openedBy', 'name').populate('closedBy', 'name').lean();
    if (!closed) throw new ConflictException('Este caixa já foi fechado.');

    const movements = await this.movements.find({ shiftId: shift._id }).populate('recordedBy', 'name').sort({ recordedAt: -1 }).lean();
    await this.autoPrintCash(actor, 'CLOSE');
    return { shift: closed, summary: { ...summary, declaredCashCents: declared, differenceCents: difference }, movements };
  }

  async assertOpen(actor: CashActor) {
    await this.assertAccess(actor);
    return this.openShift(actor);
  }

  async recordSale(actor: CashActor, input: { amountCents: number; method: string; sourceId?: string; sourceKey: string; note?: string }) {
    await this.assertAccess(actor);
    const method = input.method as PaymentMethod;
    if (!['PIX', 'CASH', 'CREDIT_CARD', 'DEBIT_CARD'].includes(method)) throw new BadRequestException('Forma de pagamento inválida para o caixa.');
    if (input.amountCents <= 0) return;
    const shift = await this.openShift(actor);
    const existing = await this.movements.findOne({ sourceKey: input.sourceKey }).lean();
    if (existing) return existing;
    try {
      return await this.movements.create({
        restaurantId: this.rid(actor), shiftId: shift._id, type: 'SALE', amountCents: input.amountCents, method,
        recordedBy: this.uid(actor), recordedAt: new Date(), note: input.note?.trim() || undefined,
        sourceType: 'TABLE_PAYMENT', sourceId: input.sourceId, sourceKey: input.sourceKey,
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return this.movements.findOne({ sourceKey: input.sourceKey }).lean();
      throw error;
    }
  }

  async printCurrent(actor: CashActor) {
    await this.assertAccess(actor);
    const rid = this.rid(actor);
    const shift = await this.shifts.findOne({ restaurantId: rid }).sort({ openedAt: -1 }).populate('openedBy', 'name').populate('closedBy', 'name').lean();
    if (!shift) throw new NotFoundException('Nenhuma operação de caixa encontrada para imprimir.');
    const context = await this.contextForShift(rid, shift as any);
    const paper = await this.printer.paperWidthForActor(actor);
    const content = await this.receiptContent(rid, context.shift, context.summary, context.movements, shift.status === 'CLOSED' ? 'FECHAMENTO DE CAIXA' : 'MOVIMENTO DO CAIXA', paper);
    return this.printer.queueCashierTextForActor(actor, shift.status === 'CLOSED' ? 'CASH_CLOSE' : 'CASH_SUMMARY', content, { shiftId: String((shift as any)._id), status: shift.status });
  }

  async printMovement(actor: CashActor, movementId: string) {
    await this.assertAccess(actor);
    const rid = this.rid(actor);
    const movement = await this.movements.findOne({ _id: this.oid(movementId, 'Operação de caixa inválida.'), restaurantId: rid }).populate('recordedBy', 'name').lean();
    if (!movement) throw new NotFoundException('Operação de caixa não encontrada.');
    const shift = await this.shifts.findOne({ _id: movement.shiftId, restaurantId: rid }).populate('openedBy', 'name').lean();
    if (!shift) throw new NotFoundException('Caixa não encontrado.');
    const paper = await this.printer.paperWidthForActor(actor);
    const content = await this.movementReceiptContent(rid, shift as any, movement as any, paper);
    return this.printer.queueCashierTextForActor(actor, `CASH_${movement.type}`, content, { shiftId: String(movement.shiftId), movementId: String((movement as any)._id), type: movement.type });
  }

  private async autoPrintCash(actor: CashActor, operation: 'OPEN' | 'SUPPLY' | 'WITHDRAWAL' | 'CLOSE', movementId?: string) {
    try {
      const settings = await this.printer.automaticSettings(actor.restaurantId);
      if (!settings.enabled) return;
      const allowed = operation === 'OPEN' ? settings.cashOpen : operation === 'SUPPLY' ? settings.cashSupply : operation === 'WITHDRAWAL' ? settings.cashWithdrawal : settings.cashClose;
      if (!allowed) return;
      if (operation === 'CLOSE') await this.printCurrent(actor);
      else if (movementId) await this.printMovement(actor, movementId);
    } catch (error) {
      this.logger.error(`Falha na impressão automática da operação de caixa ${operation}`, error instanceof Error ? error.stack : String(error));
    }
  }

  private async contextForShift(rid: Types.ObjectId, shift: any) {
    const [summary, movements] = await Promise.all([
      this.summaryForShift(shift._id),
      this.movements.find({ shiftId: shift._id }).populate('recordedBy', 'name').sort({ recordedAt: -1 }).limit(100).lean(),
    ]);
    return { shift, summary, movements, lastClosed: null };
  }

  private async closedPreview(rid: Types.ObjectId, shift: any) {
    const summary = await this.summaryForShift(shift._id);
    return { shift, summary };
  }

  private async summaryForShift(shiftId: Types.ObjectId) {
    const rows = await this.movements.find({ shiftId }).select('type amountCents method').lean();
    const summary = this.emptySummary();
    for (const row of rows) {
      const amount = Number(row.amountCents || 0);
      if (row.type === 'OPENING') summary.openingAmountCents += amount;
      else if (row.type === 'SUPPLY') summary.supplyCents += amount;
      else if (row.type === 'WITHDRAWAL') summary.withdrawalCents += amount;
      else if (row.type === 'SALE') {
        summary.salesCents += amount;
        if (row.method === 'CASH') summary.cashSalesCents += amount;
        else if (row.method === 'PIX') summary.pixSalesCents += amount;
        else if (row.method === 'CREDIT_CARD') summary.creditSalesCents += amount;
        else if (row.method === 'DEBIT_CARD') summary.debitSalesCents += amount;
      }
    }
    summary.expectedCashCents = Math.max(0, summary.openingAmountCents + summary.supplyCents + summary.cashSalesCents - summary.withdrawalCents);
    return summary;
  }

  private emptySummary() {
    return { openingAmountCents: 0, supplyCents: 0, withdrawalCents: 0, salesCents: 0, cashSalesCents: 0, pixSalesCents: 0, creditSalesCents: 0, debitSalesCents: 0, expectedCashCents: 0 };
  }

  private async openShift(actor: CashActor) {
    const shift = await this.shifts.findOne({ restaurantId: this.rid(actor), status: 'OPEN' });
    if (!shift) throw new ConflictException('Abra o caixa antes de registrar pagamentos ou operações.');
    return shift;
  }

  private async assertAccess(actor: CashActor) {
    if (actor.role === Role.RESTAURANT_ADMIN) return;
    if (actor.role !== Role.EMPLOYEE) throw new ForbiddenException('Sem acesso ao caixa.');
    const employee = await this.users.findOne({ _id: this.uid(actor), restaurantId: this.rid(actor), role: Role.EMPLOYEE, active: true, deletedAt: null }).select('employeePosition permissions').lean();
    const implied = ['CASHIER', 'MANAGER'].includes(employee?.employeePosition ?? '');
    const permitted = (employee?.permissions ?? []).some((permission) => ['TABLES_PAYMENT', 'TABLES_CLOSE', 'TABLES_DISCOUNT'].includes(permission));
    if (!employee || (!implied && !permitted)) throw new ForbiddenException('Seu usuário não possui acesso às operações do caixa.');
  }

  private async receiptContent(rid: Types.ObjectId, shift: any, summary: any, movements: any[], title: string, paper: 58 | 80) {
    const restaurant = await this.restaurants.findById(rid).select('name tradeName').lean();
    const w = paper === 58 ? 30 : 46;
    const lines = [this.center(restaurant?.tradeName || restaurant?.name || 'MENU FLOW', w), this.center(title, w), this.hr(w)];
    lines.push(`Abertura: ${this.date(shift.openedAt)}`);
    if (shift.openedBy?.name) lines.push(`Aberto por: ${shift.openedBy.name}`);
    if (shift.closedAt) lines.push(`Fechamento: ${this.date(shift.closedAt)}`);
    if (shift.closedBy?.name) lines.push(`Fechado por: ${shift.closedBy.name}`);
    lines.push(this.hr(w));
    lines.push(...this.itemLine('Fundo inicial', this.money(summary.openingAmountCents), w));
    lines.push(...this.itemLine('Suprimentos', this.money(summary.supplyCents), w));
    lines.push(...this.itemLine('Sangrias', `-${this.money(summary.withdrawalCents)}`, w));
    lines.push(...this.itemLine('Vendas dinheiro', this.money(summary.cashSalesCents), w));
    lines.push(...this.itemLine('Vendas PIX', this.money(summary.pixSalesCents), w));
    lines.push(...this.itemLine('Credito', this.money(summary.creditSalesCents), w));
    lines.push(...this.itemLine('Debito', this.money(summary.debitSalesCents), w));
    lines.push(this.hr(w));
    lines.push(...this.itemLine('DINHEIRO ESPERADO', this.money(summary.expectedCashCents), w));
    if (shift.status === 'CLOSED') {
      lines.push(...this.itemLine('DINHEIRO INFORMADO', this.money(shift.declaredCashCents ?? summary.expectedCashCents), w));
      lines.push(...this.itemLine('DIFERENCA', this.money(shift.differenceCents ?? 0), w));
    }
    lines.push(this.hr(w), `Operacoes: ${movements.length}`, this.center('MENU FLOW', w), '', '');
    return lines.join('\n');
  }

  private async movementReceiptContent(rid: Types.ObjectId, shift: any, movement: any, paper: 58 | 80) {
    const restaurant = await this.restaurants.findById(rid).select('name tradeName').lean();
    const w = paper === 58 ? 30 : 46;
    const labels: Record<string, string> = { OPENING: 'ABERTURA', SUPPLY: 'SUPRIMENTO', WITHDRAWAL: 'SANGRIA', SALE: 'VENDA' };
    const lines = [this.center(restaurant?.tradeName || restaurant?.name || 'MENU FLOW', w), this.center(`COMPROVANTE - ${labels[movement.type] || movement.type}`, w), this.hr(w)];
    lines.push(`Data: ${this.date(movement.recordedAt)}`);
    if (movement.recordedBy?.name) lines.push(`Responsavel: ${movement.recordedBy.name}`);
    if (movement.method) lines.push(`Forma: ${this.methodLabel(movement.method)}`);
    lines.push(...this.itemLine('Valor', this.money(movement.amountCents), w));
    if (movement.note) lines.push(this.hr(w), ...this.wrap(`Obs: ${movement.note}`, w));
    lines.push(this.hr(w), `Caixa: ${String(shift._id).slice(-6).toUpperCase()}`, this.center('MENU FLOW', w), '', '');
    return lines.join('\n');
  }

  private rid(actor: CashActor) { return this.oid(actor.restaurantId, 'Estabelecimento inválido.'); }
  private uid(actor: CashActor) { return this.oid(actor.sub, 'Usuário inválido.'); }
  private oid(value: string, message: string) { if (!Types.ObjectId.isValid(value)) throw new BadRequestException(message); return new Types.ObjectId(value); }
  private money(cents: number) { return `R$ ${(Number(cents || 0) / 100).toFixed(2).replace('.', ',')}`; }
  private date(value: Date | string) { return new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
  private hr(w: number) { return '-'.repeat(w); }
  private center(value: string, w: number) { const clean = String(value).slice(0, w); return `${' '.repeat(Math.max(0, Math.floor((w - clean.length) / 2)))}${clean}`; }
  private wrap(value: string, w: number) { const words = String(value).trim().split(/\s+/); const lines: string[] = []; let line = ''; for (const word of words) { if (!line) line = word; else if (`${line} ${word}`.length <= w) line += ` ${word}`; else { lines.push(line); line = word; } } if (line) lines.push(line); return lines; }
  private itemLine(label: string, value: string, w: number) { const maxLabel = Math.max(8, w - value.length - 1); const labels = this.wrap(label, maxLabel); const result = labels.slice(0, -1); const last = labels.at(-1) || ''; result.push(`${last}${' '.repeat(Math.max(1, w - last.length - value.length))}${value}`); return result; }
  private methodLabel(method: string) { return ({ CASH: 'Dinheiro', PIX: 'PIX', CREDIT_CARD: 'Credito', DEBIT_CARD: 'Debito' } as Record<string, string>)[method] || method; }
}
