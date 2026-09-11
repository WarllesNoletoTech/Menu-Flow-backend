import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import {
  AuditLog,
  BillingCounter,
  BillingInvoice,
  BillingInvoiceStatus,
  BillingPlan,
  BillingReport,
  BillingReportStatus,
  BillingTier,
  Order,
  PlatformBillingSettings,
  Restaurant,
  ServiceReportItem,
  User,
} from "../common/schemas";
import {
  OrderMetricsService,
  zonedDayRange,
  zonedPeriodRange,
} from "../orders/order-metrics.service";
import {
  DEFAULT_BILLING_TIMEZONE,
  isFirstTuesday,
} from "./billing-rules";
import { renderBillingReportPdf } from "./billing-pdf";
import { zonedDateRange } from "../common/date-range";

export function sumOrderServiceFees(
  orders: Array<{ customerServiceFeeCents?: number }>,
) {
  return orders.reduce(
    (total, order) => total + (order.customerServiceFeeCents ?? 0),
    0,
  );
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private logoCache?: Buffer;
  constructor(
    @InjectModel(BillingPlan.name) private plans: Model<BillingPlan>,
    @InjectModel(BillingInvoice.name) private invoices: Model<BillingInvoice>,
    @InjectModel(BillingReport.name) private reports: Model<BillingReport>,
    @InjectModel(ServiceReportItem.name)
    private reportItems: Model<ServiceReportItem>,
    @InjectModel(PlatformBillingSettings.name)
    private settings: Model<PlatformBillingSettings>,
    @InjectModel(BillingCounter.name) private counters: Model<BillingCounter>,
    @InjectModel(Restaurant.name) private restaurants: Model<Restaurant>,
    @InjectModel(Order.name) private orders: Model<Order>,
    @InjectModel(AuditLog.name) private audits: Model<AuditLog>,
    private metrics: OrderMetricsService,
    @InjectModel(User.name) private users: Model<User>,
    private config: ConfigService,
  ) {}

  async previewReport(
    restaurantId: string,
    start: string,
    end: string,
    chargeDate?: string,
  ) {
    const { restaurant, periodStart, periodEnd } = await this.reportContext(
      restaurantId,
      start,
      end,
    );
    const allOrders = await this.eligibleOrders(
      restaurantId,
      periodStart,
      periodEnd,
    );
    const billed = allOrders.length
      ? await this.reportItems
          .find({
            orderId: { $in: allOrders.map((o) => (o as any)._id) },
            active: true,
          })
          .select("orderId")
          .lean()
      : [];
    const billedIds = new Set(billed.map((item) => item.orderId.toString()));
    const eligible = allOrders.filter(
      (order) => !billedIds.has((order as any)._id.toString()),
    );
    const monthKey = this.monthKey(
      periodStart,
      restaurant.timezone || DEFAULT_BILLING_TIMEZONE,
    );
    const monthlyFeeAlreadyIncluded = Boolean(
      await this.reports.exists({
        restaurantId: this.objectId(restaurantId),
        includeMonthlyFee: true,
        status: {
          $in: [
            BillingReportStatus.DRAFT,
            BillingReportStatus.GENERATED,
            BillingReportStatus.PAID,
          ],
        },
        periodStart: {
          $gte: new Date(`${monthKey}-01T00:00:00-03:00`),
          $lt: this.nextMonth(monthKey),
        },
      }),
    );
    return {
      restaurant: {
        id: (restaurant as any)._id,
        name: restaurant.tradeName || restaurant.name,
      },
      periodStart,
      periodEnd,
      timezone: restaurant.timezone || DEFAULT_BILLING_TIMEZONE,
      orderCount: eligible.length,
      serviceFeeTotalCents: sumOrderServiceFees(eligible),
      alreadyBilledCount: allOrders.length - eligible.length,
      monthlyFeeAlreadyIncluded,
      suggestMonthlyFee: isFirstTuesday(
        chargeDate ? new Date(`${chargeDate}T12:00:00Z`) : new Date(),
        restaurant.timezone || DEFAULT_BILLING_TIMEZONE,
      ),
    };
  }
  async generateReport(
    input: {
      restaurantId: string;
      periodStart: string;
      periodEnd: string;
      includeMonthlyFee: boolean;
      monthlyFeeCents?: number;
    },
    actorId: string,
  ) {
    if (
      input.includeMonthlyFee &&
      (!Number.isInteger(input.monthlyFeeCents) || input.monthlyFeeCents! <= 0)
    )
      throw new BadRequestException(
        "Informe uma mensalidade válida em centavos.",
      );
    const preview = await this.previewReport(
      input.restaurantId,
      input.periodStart,
      input.periodEnd,
    );
    if (input.includeMonthlyFee && preview.monthlyFeeAlreadyIncluded)
      throw new ConflictException(
        "A mensalidade deste mês já está incluída em outro relatório.",
      );
    const monthly = input.includeMonthlyFee ? input.monthlyFeeCents! : 0;
    if (!preview.orderCount && !monthly)
      throw new BadRequestException(
        "Não existem novos pedidos nem mensalidade para cobrar neste relatório.",
      );
    const { restaurant, periodStart, periodEnd } = await this.reportContext(
      input.restaurantId,
      input.periodStart,
      input.periodEnd,
    );
    const allOrders = await this.eligibleOrders(
      input.restaurantId,
      periodStart,
      periodEnd,
    );
    const billed = allOrders.length
      ? await this.reportItems
          .find({
            orderId: { $in: allOrders.map((o) => (o as any)._id) },
            active: true,
          })
          .select("orderId")
          .lean()
      : [];
    const billedIds = new Set(billed.map((item) => item.orderId.toString()));
    const orders = allOrders.filter(
      (order) => !billedIds.has((order as any)._id.toString()),
    );
    const serviceFeeTotalCents = sumOrderServiceFees(orders);
    const now = new Date(),
      reportNumber = await this.nextReportNumber(now),
      payment = await this.settings.findOne({ key: "global" }).lean();
    const report = await this.reports.create({
      restaurantId: this.objectId(input.restaurantId),
      reportNumber,
      periodStart,
      periodEnd,
      timezone: restaurant.timezone || DEFAULT_BILLING_TIMEZONE,
      orderCount: orders.length,
      serviceFeeTotalCents,
      includeMonthlyFee: input.includeMonthlyFee,
      monthlyFeeCents: monthly,
      totalCents: serviceFeeTotalCents + monthly,
      status: BillingReportStatus.GENERATED,
      generatedAt: now,
      generatedBy: new Types.ObjectId(actorId),
      restaurantSnapshot: {
        name: restaurant.name,
        tradeName: restaurant.tradeName,
        cnpj: restaurant.cnpj,
        city: restaurant.city,
        state: restaurant.state,
      },
      paymentSnapshot: {
        pixReceiverName: payment?.pixReceiverName,
        pixKey: payment?.pixKey,
      },
    });
    try {
      if (orders.length)
        await this.reportItems.insertMany(
          orders.map((o) => ({
            reportId: report._id,
            orderId: (o as any)._id,
            restaurantId: this.objectId(input.restaurantId),
            active: true,
            orderNumber: o.orderNumber,
            completedAt: o.completedAt,
            fulfillment: o.fulfillment,
            orderTotalCents: o.totalCents ?? Math.round(o.total * 100),
            feeCents: o.customerServiceFeeCents ?? 0,
          })),
          { ordered: true },
        );
    } catch (error) {
      await this.reports.deleteOne({ _id: report._id });
      if ((error as any).code === 11000)
        throw new ConflictException(
          "Um ou mais pedidos já foram cobrados em outro relatório.",
        );
      throw error;
    }
    await this.audit(actorId, "REPORT_GENERATED", report._id, {
      reportNumber,
      totalCents: report.totalCents,
    });
    return this.report(report.id, input.restaurantId, true);
  }
  async listReports(
    filter: {
      restaurantId?: string;
      status?: string;
      start?: string;
      end?: string;
      monthly?: string;
    } = {},
    merchantId?: string,
  ) {
    const query: any = {};
    const scoped = merchantId || filter.restaurantId;
    if (scoped) query.restaurantId = this.objectId(scoped);
    if (filter.status) query.status = filter.status;
    if (filter.start || filter.end)
      query.periodStart = {
        ...(filter.start
          ? { $gte: new Date(`${filter.start}T00:00:00Z`) }
          : {}),
        ...(filter.end
          ? { $lte: new Date(`${filter.end}T23:59:59.999Z`) }
          : {}),
      };
    if (filter.monthly === "true" || filter.monthly === "false")
      query.includeMonthlyFee = filter.monthly === "true";
    const values = await this.reports
      .find(query)
      .populate("restaurantId", "name tradeName")
      .sort({ generatedAt: -1 })
      .lean();
    if (merchantId) return values;
    const ownerIds = values
      .map((v) => (v as any).restaurantId?._id ?? (v as any).restaurantId)
      .filter(Boolean);
    const owners = await this.users
      .find({
        role: "RESTAURANT_ADMIN",
        restaurantId: { $in: ownerIds },
        active: true,
        $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
      })
      .select("name reportWhatsapp restaurantId createdAt")
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    const byRestaurant = new Map<string, any>();
    for (const owner of owners)
      if (!byRestaurant.has(owner.restaurantId!.toString()))
        byRestaurant.set(owner.restaurantId!.toString(), owner);
    return values.map((v) => ({
      ...v,
      reportRecipient: byRestaurant.get(
        ((v as any).restaurantId?._id ?? (v as any).restaurantId).toString(),
      )
        ? {
            name: byRestaurant.get(
              (
                (v as any).restaurantId?._id ?? (v as any).restaurantId
              ).toString(),
            ).name,
            reportWhatsapp: byRestaurant.get(
              (
                (v as any).restaurantId?._id ?? (v as any).restaurantId
              ).toString(),
            ).reportWhatsapp,
          }
        : null,
    }));
  }
  async report(id: string, restaurantId?: string, admin = false) {
    const query: any = { _id: id };
    if (restaurantId && !admin)
      query.restaurantId = this.objectId(restaurantId);
    const value = await this.reports
      .findOne(query)
      .populate("restaurantId", "name tradeName")
      .lean();
    if (!value) throw new NotFoundException("Relatório não encontrado.");
    return {
      ...value,
      items: await this.reportItems
        .find({ reportId: (value as any)._id, active: true })
        .sort({ completedAt: 1 })
        .lean(),
    };
  }
  async reportPdf(id: string, restaurantId?: string, admin = false) {
    const data: any = await this.report(id, restaurantId, admin);
    let pdf: Buffer;
    const logo = await this.billingLogo();
    try {
      pdf = renderBillingReportPdf(data, data.items, logo);
    } catch (error) {
      if (!logo) throw error;
      this.logger.warn(
        `Logo oficial inválida ou incompatível no PDF; usando fallback textual: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.logoCache = undefined;
      pdf = renderBillingReportPdf(data, data.items);
    }
    await this.reports.updateOne(
      { _id: id },
      { $set: { pdfGeneratedAt: new Date() } },
    );
    return { pdf, filename: `${data.reportNumber}.pdf` };
  }
  async setReportStatus(
    id: string,
    status: BillingReportStatus,
    actorId: string,
  ) {
    if (status !== BillingReportStatus.PAID)
      throw new BadRequestException("Status administrativo inválido.");
    const report = await this.reports.findById(id);
    if (!report) throw new NotFoundException("Relatório não encontrado.");
    if (report.status === BillingReportStatus.PAID)
      throw new ConflictException("Relatório já está pago.");
    if (report.status === BillingReportStatus.CANCELLED)
      throw new ConflictException("Relatório cancelado não pode ser alterado.");
    report.status = status;
    report.paidAt = new Date();
    report.paidBy = new Types.ObjectId(actorId);
    await report.save();
    await this.audit(actorId, "REPORT_PAID", report._id, {
      reportNumber: report.reportNumber,
      totalCents: report.totalCents,
    });
    return report;
  }
  async deleteReport(id: string, actorId: string) {
    const report = await this.reports.findById(id);
    if (!report) throw new NotFoundException("Relatório não encontrado.");
    if (report.status === BillingReportStatus.PAID)
      throw new ConflictException("Relatórios pagos não podem ser excluídos.");
    const deletedAt = new Date();
    await this.audit(actorId, "REPORT_DELETED", report._id, {
      reportNumber: report.reportNumber,
      restaurantId: report.restaurantId.toString(),
      totalCents: report.totalCents,
      deletedBy: actorId,
      deletedAt,
    });
    await this.reportItems.deleteMany({ reportId: report._id });
    await this.reports.deleteOne({ _id: report._id });
    return { deleted: true, id };
  }
  getPaymentSettings() {
    return this.settings
      .findOne({ key: "global" })
      .select("pixReceiverName pixKey updatedAt updatedBy")
      .lean();
  }
  async updatePaymentSettings(
    input: { pixReceiverName: string; pixKey: string },
    actorId: string,
  ) {
    const pixReceiverName = input.pixReceiverName.trim(),
      pixKey = input.pixKey.trim();
    if (!pixReceiverName || !pixKey)
      throw new BadRequestException(
        "Informe o nome do recebedor e a chave PIX.",
      );
    const value = await this.settings.findOneAndUpdate(
      { key: "global" },
      {
        $set: {
          pixReceiverName,
          pixKey,
          updatedBy: new Types.ObjectId(actorId),
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
    await this.audits.create({
      actorId: new Types.ObjectId(actorId),
      action: "BILLING_PIX_SETTINGS_UPDATED",
      targetType: "PlatformBillingSettings",
      targetId: value._id,
      metadata: {},
    });
    return value;
  }

  private async billingLogo() {
    if (this.logoCache) return this.logoCache;
    const candidates = [
      resolve(
        process.cwd(),
        "Menu-Flow-frontend/public/assets/branding/menu-flow-wordmark.png",
      ),
      resolve(
        process.cwd(),
        "../Menu-Flow-frontend/public/assets/branding/menu-flow-wordmark.png",
      ),
    ];
    for (const path of candidates) {
      if (existsSync(path)) {
        this.logoCache = readFileSync(path);
        return this.logoCache;
      }
    }
    const frontend = this.config
      .get<string>("FRONTEND_URL")
      ?.trim()
      .replace(/\/$/, "");
    if (frontend) {
      try {
        const response = await fetch(
          `${frontend}/assets/branding/menu-flow-wordmark.png`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.logoCache = Buffer.from(await response.arrayBuffer());
        return this.logoCache;
      } catch (error) {
        this.logger.warn(
          `Não foi possível carregar a logo oficial para o PDF: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else
      this.logger.warn(
        "FRONTEND_URL não configurada; PDF usará fallback textual.",
      );
    return undefined;
  }
  private async reportContext(id: string, start: string, end: string) {
    const restaurant = await this.restaurants
      .findById(this.objectId(id))
      .lean();
    if (!restaurant)
      throw new NotFoundException("Estabelecimento não encontrado.");
    const periodStart = new Date(start),
      periodEnd = new Date(end);
    if (
      !Number.isFinite(periodStart.getTime()) ||
      !Number.isFinite(periodEnd.getTime()) ||
      periodStart > periodEnd
    )
      throw new BadRequestException("Período inválido.");
    return { restaurant, periodStart, periodEnd };
  }
  private eligibleOrders(id: string, start: Date, end: Date) {
    return this.orders
      .find({
        restaurantId: this.objectId(id),
        status: "COMPLETED",
        completedAt: { $gte: start, $lte: end },
      })
      .select(
        "orderNumber completedAt fulfillment total totalCents customerServiceFeeCents",
      )
      .sort({ completedAt: 1 })
      .lean();
  }
  private async nextReportNumber(now: Date) {
    const key = `report:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const counter = await this.counters.findOneAndUpdate(
      { key },
      { $inc: { sequence: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return `MF-R${String(now.getUTCFullYear()).slice(-2)}${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(counter.sequence).padStart(3, "0")}`;
  }
  private monthKey(date: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(date);
    return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
  }
  private nextMonth(key: string) {
    const [year, month] = key.split("-").map(Number);
    return new Date(
      `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01T00:00:00-03:00`,
    );
  }
  private audit(
    actorId: string,
    action: string,
    targetId: Types.ObjectId,
    metadata: Record<string, unknown>,
  ) {
    return this.audits.create({
      actorId: new Types.ObjectId(actorId),
      action,
      targetType: "BillingReport",
      targetId,
      metadata,
    });
  }
  validateTiers(tiers: BillingTier[]) {
    if (!tiers.length)
      throw new BadRequestException("Cadastre ao menos uma faixa.");
    const sorted = [...tiers].sort((a, b) => a.minOrders - b.minOrders);
    if (sorted[0].minOrders !== 0)
      throw new BadRequestException("A primeira faixa deve iniciar em 0.");
    sorted.forEach((tier, index) => {
      if (
        !Number.isInteger(tier.minOrders) ||
        !Number.isInteger(tier.amountCents) ||
        tier.amountCents < 0 ||
        (tier.maxOrders !== null &&
          (!Number.isInteger(tier.maxOrders) ||
            tier.maxOrders < tier.minOrders))
      )
        throw new BadRequestException("Faixa de cobrança inválida.");
      if (index && tier.minOrders !== (sorted[index - 1].maxOrders ?? -2) + 1)
        throw new BadRequestException(
          "As faixas devem ser contínuas e não podem se sobrepor.",
        );
      if (index < sorted.length - 1 && tier.maxOrders === null)
        throw new BadRequestException(
          "Somente a última faixa pode ser ilimitada.",
        );
    });
    if (sorted.at(-1)?.maxOrders !== null)
      throw new BadRequestException("A última faixa deve ser ilimitada.");
    return sorted;
  }
  listPlans() {
    return this.plans.find().sort({ active: -1, name: 1 }).lean();
  }
  async createPlan(input: Partial<BillingPlan>) {
    const tiers = this.validateTiers(input.tiers ?? []);
    if (input.isDefault)
      await this.plans.updateMany({}, { $set: { isDefault: false } });
    return this.plans.create({
      name: input.name,
      active: input.active ?? true,
      isDefault: input.isDefault ?? false,
      dueDay: input.dueDay,
      tiers,
    });
  }
  async updatePlan(id: string, input: Partial<BillingPlan>) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException("Plano não encontrado.");
    const changes = {
      ...input,
      ...(input.tiers ? { tiers: this.validateTiers(input.tiers) } : {}),
    };
    if (input.isDefault)
      await this.plans.updateMany(
        { _id: { $ne: id } },
        { $set: { isDefault: false } },
      );
    const plan = await this.plans.findByIdAndUpdate(
      id,
      { $set: changes },
      { new: true, runValidators: true },
    );
    if (!plan) throw new NotFoundException("Plano não encontrado.");
    return plan;
  }
  async assignRestaurant(
    id: string,
    input: {
      billingPlanId?: string;
      billingStartAt?: string;
      billingDueDay?: number;
    },
  ) {
    if (
      input.billingPlanId &&
      (!Types.ObjectId.isValid(input.billingPlanId) ||
        !(await this.plans.exists({ _id: input.billingPlanId })))
    )
      throw new NotFoundException("Plano não encontrado.");
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    for (const key of [
      "billingPlanId",
      "billingStartAt",
      "billingDueDay",
    ] as const) {
      const value = input[key];
      if (value === undefined || value === "") unset[key] = 1;
      else
        set[key] = key === "billingStartAt" ? new Date(value as string) : value;
    }
    const restaurant = await this.restaurants.findByIdAndUpdate(
      id,
      {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
      { new: true },
    );
    if (!restaurant)
      throw new NotFoundException("Estabelecimento não encontrado.");
    return restaurant;
  }
  periodRange(period: string, timezone = "America/Sao_Paulo") {
    return zonedPeriodRange(period, timezone);
  }
  tierFor(plan: BillingPlan, count: number) {
    const tier = plan.tiers.find(
      (t) =>
        count >= t.minOrders && (t.maxOrders === null || count <= t.maxOrders),
    );
    if (!tier)
      throw new BadRequestException(
        "O plano não cobre esta quantidade de pedidos.",
      );
    return tier;
  }
  async estimateRestaurant(restaurantId: string, period: string) {
    const rid = this.objectId(restaurantId);
    const restaurant = await this.restaurants
      .findById(rid)
      .populate("billingPlanId")
      .lean();
    if (!restaurant)
      throw new NotFoundException("Estabelecimento não encontrado.");
    const { start, end } = this.periodRange(period, restaurant.timezone);
    const lower =
      restaurant.billingStartAt && restaurant.billingStartAt > start
        ? restaurant.billingStartAt
        : start;
    const count = await this.metrics.countCompleted(rid, lower, end);
    const summary = {
      id: (restaurant as any)._id,
      name: restaurant.tradeName || restaurant.name,
    };
    if (!restaurant.billingPlanId)
      return {
        period,
        restaurant: summary,
        completedOrderCount: count,
        plan: null,
        tier: null,
        amountCents: null,
        estimated: true,
      };
    const plan = restaurant.billingPlanId as unknown as BillingPlan & {
      _id: Types.ObjectId;
    };
    const tier = this.tierFor(plan, count);
    return {
      period,
      restaurant: summary,
      completedOrderCount: count,
      plan: { id: plan._id, name: plan.name },
      tier,
      amountCents: tier.amountCents,
      estimated: true,
    };
  }
  async generate(period: string) {
    const { start, end } = this.periodRange(period);
    const restaurants = await this.restaurants
      .find({ billingPlanId: { $exists: true }, billingStartAt: { $lte: end } })
      .populate("billingPlanId")
      .lean();
    const results = [];
    for (const restaurant of restaurants) {
      const existing = await this.invoices.exists({
        restaurantId: (restaurant as any)._id,
        period,
      });
      if (existing) {
        results.push({
          restaurantId: (restaurant as any)._id,
          alreadyExists: true,
        });
        continue;
      }
      const plan = restaurant.billingPlanId as unknown as BillingPlan & {
        _id: Types.ObjectId;
      };
      const count = await this.count(
        (restaurant as any)._id.toString(),
        start,
        end,
        restaurant.billingStartAt,
      );
      const tier = this.tierFor(plan, count);
      const dueDay = restaurant.billingDueDay ?? plan.dueDay;
      if (!dueDay) {
        results.push({
          restaurantId: (restaurant as any)._id,
          error: "Vencimento não definido",
        });
        continue;
      }
      const [year, month] = period.split("-").map(Number);
      const dueDate = new Date(
        `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-${String(dueDay).padStart(2, "0")}T23:59:59-03:00`,
      );
      try {
        const invoice = await this.invoices.create({
          restaurantId: (restaurant as any)._id,
          billingPlanId: plan._id,
          period,
          periodStart: start,
          periodEnd: end,
          completedOrderCount: count,
          amountCents: tier.amountCents,
          dueDate,
          pricingSnapshot: {
            planName: plan.name,
            tier: {
              minOrders: tier.minOrders,
              maxOrders: tier.maxOrders,
              amountCents: tier.amountCents,
            },
            timezone: "America/Sao_Paulo",
          },
        });
        results.push({
          restaurantId: (restaurant as any)._id,
          invoiceId: invoice.id,
          created: true,
        });
      } catch (e) {
        if ((e as any).code === 11000)
          results.push({
            restaurantId: (restaurant as any)._id,
            alreadyExists: true,
          });
        else throw e;
      }
    }
    return { period, results };
  }
  async listInvoices(page = 1, limit = 20, status?: string) {
    const filter = status ? { status } : {};
    const [items, total] = await Promise.all([
      this.invoices
        .find(filter)
        .populate("restaurantId", "name tradeName cnpj")
        .populate("billingPlanId", "name")
        .sort({ period: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.invoices.countDocuments(filter),
    ]);
    return {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }
  async invoice(id: string) {
    const value = await this.invoices
      .findById(id)
      .populate("restaurantId", "name tradeName cnpj")
      .populate("billingPlanId", "name")
      .lean();
    if (!value) throw new NotFoundException("Fatura não encontrada.");
    return value;
  }
  async setStatus(id: string, status: BillingInvoiceStatus, actorId: string) {
    if (
      ![
        BillingInvoiceStatus.PAID,
        BillingInvoiceStatus.WAIVED,
        BillingInvoiceStatus.CANCELLED,
      ].includes(status)
    )
      throw new BadRequestException("Status administrativo inválido.");
    const update: any = { $set: { status }, $unset: { paidAt: 1, paidBy: 1 } };
    if (status === BillingInvoiceStatus.PAID) {
      update.$set.paidAt = new Date();
      update.$set.paidBy = actorId;
      delete update.$unset;
    }
    const invoice = await this.invoices.findByIdAndUpdate(id, update, {
      new: true,
    });
    if (!invoice) throw new NotFoundException("Fatura não encontrada.");
    await this.audits.create({
      actorId,
      action: `INVOICE_${status}`,
      targetType: "BillingInvoice",
      targetId: invoice._id,
    });
    return invoice;
  }
  async dashboard() {
    const now = new Date();
    await this.invoices.updateMany(
      { status: BillingInvoiceStatus.OPEN, dueDate: { $lt: now } },
      { $set: { status: BillingInvoiceStatus.OVERDUE } },
    );
    const period = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
    })
      .format(now)
      .replace("/", "-");
    const { start, end } = this.periodRange(period);
    const [open, overdue, total, orders, withoutPlan] = await Promise.all([
      this.invoices.countDocuments({ status: BillingInvoiceStatus.OPEN }),
      this.invoices.countDocuments({ status: BillingInvoiceStatus.OVERDUE }),
      this.invoices.aggregate([
        {
          $match: {
            status: {
              $in: [BillingInvoiceStatus.OPEN, BillingInvoiceStatus.OVERDUE],
            },
          },
        },
        { $group: { _id: null, total: { $sum: "$amountCents" } } },
      ]),
      this.orders.countDocuments({
        status: "COMPLETED",
        completedAt: { $gte: start, $lte: end },
      }),
      this.restaurants.countDocuments({ billingPlanId: { $exists: false } }),
    ]);
    return {
      open,
      overdue,
      openAmountCents: total[0]?.total ?? 0,
      completedOrdersThisMonth: orders,
      restaurantsWithoutPlan: withoutPlan,
      period,
    };
  }

  async merchantSalesReport(restaurantId: string, startDate: string, endDate: string) {
    const rid = this.objectId(restaurantId);
    const restaurant = await this.restaurants.findById(rid).select("timezone").lean();
    if (!restaurant) throw new NotFoundException("Estabelecimento não encontrado.");
    const timezone = restaurant.timezone || 'America/Sao_Paulo';
    const { start, end } = zonedDateRange(startDate, endDate, timezone);
    const [orders, cancelledOrders] = await Promise.all([
      this.orders.find({ restaurantId: rid, status: 'COMPLETED', completedAt: { $gte: start, $lte: end } })
        .select('orderNumber completedAt fulfillment paymentMethod items subtotal subtotalCents deliveryFee deliveryFeeCents discount discountCents total totalCents customerServiceFeeCents')
        .sort({ completedAt: 1 })
        .lean(),
      this.orders.countDocuments({ restaurantId: rid, $or: [
        { status: 'REJECTED', rejectedAt: { $gte: start, $lte: end } },
        { status: 'CANCELLED', cancelledAt: { $gte: start, $lte: end } },
      ] }),
    ]);

    const productMap = new Map<string, { productName: string; quantity: number; productRevenueCents: number }>();
    const paymentMap = new Map<string, { method: string; orders: number; salesCents: number }>();
    const fulfillmentMap = new Map<string, { fulfillment: string; orders: number; salesCents: number }>();
    const dailyMap = new Map<string, { date: string; orders: number; salesCents: number }>();
    let subtotalCents = 0;
    let deliveryFeesCents = 0;
    let discountsCents = 0;
    let serviceFeesCents = 0;
    let grossOrderVolumeCents = 0;

    const cents = (modern: number | undefined, legacy: number | undefined) => modern ?? Math.round((legacy ?? 0) * 100);
    const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    for (const order of orders as any[]) {
      const orderTotalCents = cents(order.totalCents, order.total);
      const serviceFeeCents = order.customerServiceFeeCents ?? 0;
      const merchantSalesCents = orderTotalCents - serviceFeeCents;
      subtotalCents += cents(order.subtotalCents, order.subtotal);
      deliveryFeesCents += cents(order.deliveryFeeCents, order.deliveryFee);
      discountsCents += cents(order.discountCents, order.discount);
      serviceFeesCents += serviceFeeCents;
      grossOrderVolumeCents += orderTotalCents;

      for (const item of order.items ?? []) {
        const unitPriceCents = cents(item.unitPriceCents, item.unitPrice);
        const addonCents = (item.addons ?? []).reduce((sum: number, addon: any) => sum + cents(addon.priceCents, addon.price), 0);
        const productRevenueCents = Math.max(0, item.quantity ?? 0) * (unitPriceCents + addonCents);
        const key = item.productId?.toString?.() || item.productName;
        const current = productMap.get(key) ?? { productName: item.productName || 'Produto', quantity: 0, productRevenueCents: 0 };
        current.quantity += Math.max(0, item.quantity ?? 0);
        current.productRevenueCents += productRevenueCents;
        productMap.set(key, current);
      }

      const payment = paymentMap.get(order.paymentMethod) ?? { method: order.paymentMethod, orders: 0, salesCents: 0 };
      payment.orders += 1;
      payment.salesCents += merchantSalesCents;
      paymentMap.set(order.paymentMethod, payment);

      const fulfillment = fulfillmentMap.get(order.fulfillment) ?? { fulfillment: order.fulfillment, orders: 0, salesCents: 0 };
      fulfillment.orders += 1;
      fulfillment.salesCents += merchantSalesCents;
      fulfillmentMap.set(order.fulfillment, fulfillment);

      const dayParts = Object.fromEntries(dateFormatter.formatToParts(new Date(order.completedAt)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
      const day = `${dayParts.year}-${dayParts.month}-${dayParts.day}`;
      const daily = dailyMap.get(day) ?? { date: day, orders: 0, salesCents: 0 };
      daily.orders += 1;
      daily.salesCents += merchantSalesCents;
      dailyMap.set(day, daily);
    }

    const completedOrders = orders.length;
    const grossSalesCents = grossOrderVolumeCents - serviceFeesCents;
    return {
      periodStart: start,
      periodEnd: end,
      timezone,
      salesMetrics: {
        completedOrders,
        grossSalesCents,
        grossRevenueCents: grossSalesCents,
        menuFlowServiceFeesCollectedCents: serviceFeesCents,
        grossOrderVolumeCents,
        averageTicketCents: completedOrders ? Math.round(grossSalesCents / completedOrders) : 0,
        cancelledOrders,
      },
      details: {
        subtotalCents,
        deliveryFeesCents,
        discountsCents,
        products: Array.from(productMap.values()).sort((a, b) => b.quantity - a.quantity || a.productName.localeCompare(b.productName, 'pt-BR')),
        paymentMethods: Array.from(paymentMap.values()).sort((a, b) => b.salesCents - a.salesCents),
        fulfillments: Array.from(fulfillmentMap.values()).sort((a, b) => b.salesCents - a.salesCents),
        daily: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      },
    };
  }

  async merchant(restaurantId: string, period: string) {
    const rid = this.objectId(restaurantId);
    const restaurant = await this.restaurants
      .findById(rid)
      .select("timezone")
      .lean();
    if (!restaurant)
      throw new NotFoundException("Estabelecimento não encontrado.");
    const { start, end } = this.periodRange(period, restaurant.timezone);
    const [estimate, salesMetrics, invoices] = await Promise.all([
      this.estimateRestaurant(restaurantId, period),
      this.metrics.summarize(rid, start, end),
      this.invoices
        .find({ restaurantId: rid })
        .sort({ period: -1 })
        .limit(24)
        .lean(),
    ]);
    return { period, salesMetrics, estimate, invoices };
  }
  async merchantDashboard(restaurantId: string) {
    const rid = this.objectId(restaurantId);
    const restaurant = await this.restaurants
      .findById(rid)
      .select("timezone")
      .lean();
    if (!restaurant)
      throw new NotFoundException("Estabelecimento não encontrado.");
    const { start, end } = zonedDayRange(new Date(), restaurant.timezone);
    return {
      periodStart: start,
      periodEnd: end,
      ...(await this.metrics.summarize(rid, start, end)),
    };
  }
  private count(id: string, start: Date, end: Date, billingStartAt?: Date) {
    const lower =
      billingStartAt && billingStartAt > start ? billingStartAt : start;
    return this.metrics.countCompleted(this.objectId(id), lower, end);
  }
  private objectId(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException("Estabelecimento não encontrado.");
    }
    return new Types.ObjectId(id);
  }
}
