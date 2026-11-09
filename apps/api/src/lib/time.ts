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
