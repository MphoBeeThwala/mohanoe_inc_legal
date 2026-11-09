import type { UserRole } from '@ahava88/shared';
import type { FirmRow } from '../db/schema';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      /** The firm (tenant) this request belongs to, from the host name. */
      firm?: FirmRow;
      auth?: {
        userId: string;
        firmId: string;
        email: string;
        role: UserRole;
        fullName: string;
      };
    }
  }
}

export {};
