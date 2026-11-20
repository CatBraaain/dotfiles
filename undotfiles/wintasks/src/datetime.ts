export interface DateTime {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export function dateTime(y: number, mo: number, d: number, h: number, mi: number): DateTime {
  return { y, mo, d, h, mi, s: 0 };
}

export function addDays(t: DateTime, days: number): DateTime {
  const date = new Date(Date.UTC(t.y, t.mo - 1, t.d + days));
  return { ...t, y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

export function isAfter(a: DateTime, b: DateTime): boolean {
  return a.y !== b.y
    ? a.y > b.y
    : a.mo !== b.mo
      ? a.mo > b.mo
      : a.d !== b.d
        ? a.d > b.d
        : a.h !== b.h
          ? a.h > b.h
          : a.mi !== b.mi
            ? a.mi > b.mi
            : a.s > b.s;
}

export function formatDateTime(t: DateTime): string {
  const year = String(t.y).padStart(4, "0");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(t.mo)}-${pad(t.d)}T${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}`;
}

export function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

export function validDate(y: number, mo: number, d: number): boolean {
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}
