// Temporary loose types for the Supabase data layer.
// TODO(epic 3): replace DbRow with Drizzle-inferred row types and RequestBody
// with zod-inferred input types, then delete this file.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbRow = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RequestBody = Record<string, any>;

/** The signed-in user performing an action (from the JWT), or the system. */
export interface Actor {
  userId?: string | null;
  id?: string | null;
  email?: string | null;
  fullName?: string | null;
  role?: string | null;
}
