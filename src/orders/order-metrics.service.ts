import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order } from '../common/schemas';

export type OrderMetrics = {
  completedOrders: number;
  grossSalesCents: number;
  menuFlowServiceFeesCollectedCents: number;
  grossOrderVolumeCents: number;
  /** @deprecated Use grossSalesCents. */
  grossRevenueCents: number;
  averageTicketCents: number;
  pendingOrders: number;
  preparingOrders: number;
  readyOrders: number;
  cancelledOrders: number;
};

@Injectable()
export class OrderMetricsService {
  constructor(@InjectModel(Order.name) private readonly orders: Model<Order>) {}

  async summarize(restaurantId: string | Types.ObjectId, start: Date, end: Date): Promise<OrderMetrics> {
    const rid = restaurantId instanceof Types.ObjectId ? restaurantId : objectId(restaurantId);
    const rows = await this.orders.aggregate<{ _id: string; count: number; grossOrderVolumeCents: number; serviceFeesCents: number }>([
      { $match: { restaurantId: rid, $or: [
        { status: 'COMPLETED', completedAt: { $gte: start, $lte: end } },
        { status: { $ne: 'COMPLETED' }, createdAt: { $gte: start, $lte: end } },
      ] } },
      { $group: { _id: '$status', count: { $sum: 1 }, grossOrderVolumeCents: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, { $ifNull: ['$totalCents', { $round: [{ $multiply: [{ $ifNull: ['$total', 0] }, 100] }, 0] }] }, 0] } }, serviceFeesCents: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, { $ifNull: ['$customerServiceFeeCents', 0] }, 0] } } } },
    ]);
    const byStatus = new Map(rows.map((row) => [row._id, row]));
    const completedOrders = byStatus.get('COMPLETED')?.count ?? 0;
    const grossOrderVolumeCents = byStatus.get('COMPLETED')?.grossOrderVolumeCents ?? 0;
    const menuFlowServiceFeesCollectedCents = byStatus.get('COMPLETED')?.serviceFeesCents ?? 0;
    const grossSalesCents = grossOrderVolumeCents - menuFlowServiceFeesCollectedCents;
    return {
      completedOrders,
      grossSalesCents,
      menuFlowServiceFeesCollectedCents,
      grossOrderVolumeCents,
      grossRevenueCents: grossSalesCents,
      averageTicketCents: completedOrders ? Math.round(grossSalesCents / completedOrders) : 0,
      pendingOrders: byStatus.get('PENDING')?.count ?? 0,
      preparingOrders: byStatus.get('PREPARING')?.count ?? 0,
      readyOrders: byStatus.get('READY')?.count ?? 0,
      cancelledOrders: (byStatus.get('CANCELLED')?.count ?? 0) + (byStatus.get('REJECTED')?.count ?? 0),
    };
  }

  countCompleted(restaurantId: string | Types.ObjectId, start: Date, end: Date) {
    const rid = restaurantId instanceof Types.ObjectId ? restaurantId : objectId(restaurantId);
    return this.orders.countDocuments({ restaurantId: rid, status: 'COMPLETED', completedAt: { $gte: start, $lte: end } });
  }
}

function objectId(value: string) {
  if (!Types.ObjectId.isValid(value)) throw new BadRequestException('Estabelecimento inválido.');
  return new Types.ObjectId(value);
}

export function zonedPeriodRange(period: string, timezone = 'America/Sao_Paulo') {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new BadRequestException('Competência deve usar YYYY-MM.');
  const [year, month] = period.split('-').map(Number);
  return { start: zonedMidnight(year, month, 1, timezone), end: new Date(zonedMidnight(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1, timezone).getTime() - 1) };
}

export function zonedDayRange(now = new Date(), timezone = 'America/Sao_Paulo') {
  const parts = dateParts(now, timezone);
  const start = zonedMidnight(parts.year, parts.month, parts.day, timezone);
  const tomorrowProbe = new Date(start.getTime() + 36 * 60 * 60 * 1000);
  const tomorrow = dateParts(tomorrowProbe, timezone);
  return { start, end: new Date(zonedMidnight(tomorrow.year, tomorrow.month, tomorrow.day, timezone).getTime() - 1) };
}

function zonedMidnight(year: number, month: number, day: number, timezone: string) {
  let candidate = new Date(Date.UTC(year, month - 1, day));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = dateParts(candidate, timezone);
    const desiredUtc = Date.UTC(year, month - 1, day);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate = new Date(candidate.getTime() + desiredUtc - actualUtc);
  }
  return candidate;
}

function dateParts(date: Date, timezone: string) {
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  const values = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return values as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}
