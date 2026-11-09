// Dates and times in South Africa (UTC+2, no daylight saving).
export const ZONE = 'Africa/Johannesburg';

/** Today (or a moment) as YYYY-MM-DD in South Africa. */
export const localDate = (value: Date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(value);

/** A date and time entered in South Africa as an ISO string with its offset. */
export const saDateTime = (date: string, time: string) => `${date}T${time || '00:00'}:00+02:00`;
