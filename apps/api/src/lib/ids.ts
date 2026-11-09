const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value is a UUID (so it can be compared with a uuid column). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
