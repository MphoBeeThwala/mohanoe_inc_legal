import type { UserRole } from '@ahava88/shared';

/** Who is performing an action: a signed-in user, or a named system process. */
export interface Actor {
  userId?: string | null;
  email?: string | null;
  fullName?: string | null;
  role?: UserRole | 'client' | 'system' | string | null;
}

export const SYSTEM_ACTOR: Actor = { fullName: 'system', role: 'system' };

/** The name recorded in created_by / actor_name columns. */
export function actorName(actor: Actor | undefined): string {
  return actor?.fullName || actor?.email || 'system';
}
