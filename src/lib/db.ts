import mongoose, { type ClientSession } from 'mongoose';
import { env } from '../config/env';
import { logger } from './logger';

mongoose.set('strictQuery', true);
// Every Mongoose operation reached from a transaction callback (including service-level audit writes)
// automatically joins that transaction. This keeps cross-module dataset activation all-or-nothing.
mongoose.set('transactionAsyncLocalStorage', true);

const TRANSACTION_COLLISION_ATTEMPTS = 4;

export type RetryableTransactionCollision = 'audit-sequence' | 'session-slot';

/**
 * A duplicate-key race that is safe only when the complete outer transaction callback is replayed.
 * Callers must create this signal at the exact model write that owns the unique index; a bare 11000
 * is deliberately not retryable because it may be a deterministic business conflict.
 */
export class RetryableTransactionCollisionError extends Error {
  constructor(
    readonly collision: RetryableTransactionCollision,
    readonly originalError: unknown,
  ) {
    super(`Retryable Mongo transaction collision: ${collision}`);
    this.name = 'RetryableTransactionCollisionError';
  }
}

export function inMongoTransaction(): boolean {
  const storage = (mongoose as unknown as {
    transactionAsyncLocalStorage?: { getStore(): { session?: ClientSession } | undefined };
  }).transactionAsyncLocalStorage;
  return Boolean(storage?.getStore()?.session?.inTransaction());
}

/** Exact duplicate-key index evidence; avoids treating an unrelated code=11000 as retryable. */
export function isMongoDuplicateKeyFor(error: unknown, fields: readonly string[]): boolean {
  if (!error || typeof error !== 'object' || (error as { code?: number }).code !== 11000) return false;
  const pattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
  if (!pattern) return false;
  const keys = Object.keys(pattern);
  return keys.length === fields.length && fields.every((field) => pattern[field] === 1);
}

export async function withMongoTransaction<T>(work: () => Promise<T>): Promise<T> {
  // Services compose: dataset activation already owns a transaction and calls other transactional
  // services. Reuse Mongoose's ALS-bound session instead of committing an independent nested
  // transaction that could survive an outer rollback.
  if (inMongoTransaction()) return work();

  for (let attempt = 0; attempt < TRANSACTION_COLLISION_ATTEMPTS; attempt++) {
    try {
      return await mongoose.connection.transaction(work, {
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
    } catch (error) {
      if (!(error instanceof RetryableTransactionCollisionError) || attempt === TRANSACTION_COLLISION_ATTEMPTS - 1) throw error;
      logger.warn({ collision: error.collision, attempt: attempt + 1 }, 'mongo transaction collision, retrying from a fresh transaction');
    }
  }
  throw new Error('unreachable');
}

export async function connectDb(uri: string = env.MONGODB_URI): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ db: mongoose.connection.name }, 'mongodb connected');
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

export function dbStatus(): 'connected' | 'connecting' | 'disconnected' {
  const s = mongoose.connection.readyState;
  return s === 1 ? 'connected' : s === 2 ? 'connecting' : 'disconnected';
}
