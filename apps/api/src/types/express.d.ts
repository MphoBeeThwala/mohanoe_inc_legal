import type { UserRole } from '@ahava88/shared';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      auth?: {
        userId: string;
        email: string;
        role: UserRole;
        fullName: string;
      };
    }
  }
}

export {};
