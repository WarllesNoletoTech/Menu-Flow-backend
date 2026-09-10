export const MENU_FLOW_ORDER_SERVICE_FEE_CENTS = 100;
export const DEFAULT_BILLING_TIMEZONE = 'America/Sao_Paulo';

export function firstTuesdayOfMonth(year: number, month: number, timezone = DEFAULT_BILLING_TIMEZONE) {
  // Noon UTC avoids date rollover in Brazilian timezones; month is 1-based.
  for (let day = 1; day <= 7; day += 1) {
    const probe = new Date(Date.UTC(year, month - 1, day, 12));
    if (weekday(probe, timezone) === 'Tue') return day;
  }
  throw new Error('Não foi possível calcular a primeira terça-feira.');
}

export function isFirstTuesday(date: Date, timezone = DEFAULT_BILLING_TIMEZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(date).map((part) => [part.type, part.value]));
  return parts.weekday === 'Tue' && Number(parts.day) === firstTuesdayOfMonth(Number(parts.year), Number(parts.month), timezone);
}

function weekday(date: Date, timezone: string) { return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(date); }

