// Loads the repo-root .env before any other module reads process.env.
// Must be the first import in server.ts. The path resolves the same way from
// src/ (tsx in development) and dist/ (compiled), both under apps/api/.
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env'), quiet: true });
