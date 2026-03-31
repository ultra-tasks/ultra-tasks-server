import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});
export const prisma = new PrismaClient({
  adapter,
  log:
    process.env.NODE_ENV === 'development'
      ? ['query', 'info', 'warn', 'error']
      : ['error'],
});

// Re-export types for convenience
export type {
  User,
  Operation,
  UserSyncState,
  SyncDevice,
} from './generated/prisma/client';

// Helper to disconnect on shutdown
export const disconnectDb = async (): Promise<void> => {
  await prisma.$disconnect();
};
