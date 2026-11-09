/** Matter statuses that count as closed (compared in lower case). */
export const CLOSED_STATUSES = ['closed', 'resolved', 'completed'];

export function isClosed(status: string): boolean {
  return CLOSED_STATUSES.includes(status.toLowerCase());
}
