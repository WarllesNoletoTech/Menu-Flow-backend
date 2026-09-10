import { BadRequestException } from '@nestjs/common';
import { BusinessDay } from '../common/schemas';

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

export function validateBusinessHours(days: BusinessDay[]) {
  if (days.length !== 7 || new Set(days.map((day) => day.dayOfWeek)).size !== 7) throw new BadRequestException('Informe os sete dias da semana, sem repetições.');
  for (const day of days) {
    if (!day.isOpen && day.periods.length) throw new BadRequestException('Um dia fechado não pode possuir períodos.');
    if (day.isOpen && !day.periods.length) throw new BadRequestException('Adicione ao menos um período para cada dia aberto.');
    const normalized = day.periods.map((period) => {
      if (!TIME.test(period.openTime) || !TIME.test(period.closeTime) || period.openTime === period.closeTime) throw new BadRequestException('Informe horários válidos e diferentes no formato HH:mm.');
      const start = minutes(period.openTime); const rawEnd = minutes(period.closeTime);
      return { start, end: rawEnd <= start ? rawEnd + 1440 : rawEnd };
    }).sort((a, b) => a.start - b.start);
    for (let index = 1; index < normalized.length; index += 1) if (normalized[index].start < normalized[index - 1].end) throw new BadRequestException('Existem períodos duplicados ou sobrepostos no mesmo dia.');
  }
  return [...days].sort((a, b) => a.dayOfWeek - b.dayOfWeek);
}

export function openingStatus(days: BusinessDay[], timezone: string, now = new Date()) {
  if (!days.length) return { status: 'UNCONFIGURED' as const, isOpen: null };
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone || DEFAULT_TIMEZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now); }
  catch { parts = new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TIMEZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now); }
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = weekdays[value.weekday]; const current = Number(value.hour) * 60 + Number(value.minute);
  const today = days.find((item) => item.dayOfWeek === day);
  const previous = days.find((item) => item.dayOfWeek === (day + 6) % 7);
  const openToday = Boolean(today?.isOpen && today.periods.some((period) => { const start = minutes(period.openTime); const end = minutes(period.closeTime); return end > start ? current >= start && current < end : current >= start; }));
  const openFromYesterday = Boolean(previous?.isOpen && previous.periods.some((period) => { const start = minutes(period.openTime); const end = minutes(period.closeTime); return end <= start && current < end; }));
  return { status: openToday || openFromYesterday ? 'OPEN' as const : 'CLOSED' as const, isOpen: openToday || openFromYesterday };
}

export function canAcceptOrdersNow(input: {
  blocked: boolean;
  acceptingOrders: boolean;
  openingHours: BusinessDay[];
  timezone?: string;
  now?: Date;
}) {
  const schedule = openingStatus(input.openingHours, input.timezone || DEFAULT_TIMEZONE, input.now);
  return {
    canAcceptOrdersNow: !input.blocked && input.acceptingOrders && schedule.isOpen === true,
    openingStatus: schedule,
  };
}
