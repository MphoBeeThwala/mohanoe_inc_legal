/** ISO-8601 string for a timestamp column (API responses always use strings). */
export function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

export function isoOrNull(value: Date | string | null | undefined): string | null {
  return value ? iso(value) : null;
}

/** Parses an optional date input; throws on an unparseable value. */
export function toDateOrNull(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`Invalid date: ${value}`);
  }
  return parsed;
}

/** The firm's time zone for calendar dates (South Africa has one, with no DST). */
export const FIRM_TIME_ZONE = 'Africa/Johannesburg';

/** Today's calendar date (YYYY-MM-DD) in South Africa. */
export function localDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FIRM_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
