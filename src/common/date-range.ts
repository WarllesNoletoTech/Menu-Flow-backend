import { BadRequestException } from '@nestjs/common';

export type ZonedRange = { start: Date; end: Date };

export function zonedDateRange(startValue: string, endValue: string, timezone = 'America/Sao_Paulo'): ZonedRange {
  const startParts = parseDateOnly(startValue);
  const endParts = parseDateOnly(endValue);
  const startKey = startParts.year * 10000 + startParts.month * 100 + startParts.day;
  const endKey = endParts.year * 10000 + endParts.month * 100 + endParts.day;
  if (startKey > endKey) throw new BadRequestException('A data inicial não pode ser maior que a data final.');

  const start = zonedMidnight(startParts.year, startParts.month, startParts.day, timezone);
  const next = nextCalendarDay(endParts.year, endParts.month, endParts.day);
  const end = new Date(zonedMidnight(next.year, next.month, next.day, timezone).getTime() - 1);
  return { start, end };
}

function parseDateOnly(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) throw new BadRequestException('Use datas no formato YYYY-MM-DD.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) {
    throw new BadRequestException('Informe uma data válida.');
  }
  return { year, month, day };
}

function nextCalendarDay(year: number, month: number, day: number) {
  const next = new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60 * 1000);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
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
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  }
  const values = Object.fromEntries(
    formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]),
  );
  return values as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}
