import { createHash } from 'node:crypto';
import type { ClientRateLimitInfo, IncrementResponse, Options, Store } from 'express-rate-limit';
import { isMongoDuplicateKeyFor } from '../../lib/db';
import { RateLimitCounterModel, type RateLimitCounter } from './model';

const EPOCH = new Date(0);

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Fixed-window express-rate-limit store shared by every API process through the existing MongoDB.
 *
 * The aggregation update checks expiry and increments (or starts a new window) in one document
 * operation. A concurrent first request can race on the unique upsert; the loser retries against
 * the winner's row, preserving both hits without a read/modify/write gap.
 */
export class MongoRateLimitStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  private windowMs = 60_000;

  constructor(readonly namespace: string) {
    if (!/^[a-z0-9:_-]{1,80}$/i.test(namespace)) throw new Error('Invalid rate-limit namespace');
    this.prefix = `mongo-rate-limit:${namespace}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const keyHash = hashKey(key);

    // An exact unique-index collision is expected when separate app instances simultaneously see a
    // new key. Retry the complete atomic upsert; unrelated database errors remain fail-closed.
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = new Date();
      const nextResetAt = new Date(now.getTime() + this.windowMs);
      const activeWindow = { $gt: [{ $ifNull: ['$resetAt', EPOCH] }, now] };
      try {
        const counter = await RateLimitCounterModel.findOneAndUpdate(
          { namespace: this.namespace, keyHash },
          [
            {
              $set: {
                namespace: { $literal: this.namespace },
                keyHash: { $literal: keyHash },
                hits: {
                  $cond: [activeWindow, { $add: [{ $ifNull: ['$hits', 0] }, 1] }, 1],
                },
                resetAt: { $cond: [activeWindow, '$resetAt', nextResetAt] },
              },
            },
          ],
          { upsert: true, new: true, setDefaultsOnInsert: false },
        ).lean<RateLimitCounter>();

        if (!counter) throw new Error('Rate-limit counter increment returned no document');
        return { totalHits: counter.hits, resetTime: counter.resetAt };
      } catch (error) {
        if (!isMongoDuplicateKeyFor(error, ['namespace', 'keyHash']) || attempt === 2) throw error;
      }
    }

    throw new Error('Rate-limit counter increment exhausted retries');
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const counter = await RateLimitCounterModel.findOne({
      namespace: this.namespace,
      keyHash: hashKey(key),
      resetAt: { $gt: new Date() },
    })
      .select('hits resetAt')
      .lean<Pick<RateLimitCounter, 'hits' | 'resetAt'>>();
    return counter ? { totalHits: counter.hits, resetTime: counter.resetAt } : undefined;
  }

  async decrement(key: string): Promise<void> {
    await RateLimitCounterModel.updateOne(
      {
        namespace: this.namespace,
        keyHash: hashKey(key),
        resetAt: { $gt: new Date() },
        hits: { $gt: 0 },
      },
      { $inc: { hits: -1 } },
    );
  }

  async resetKey(key: string): Promise<void> {
    await RateLimitCounterModel.deleteOne({ namespace: this.namespace, keyHash: hashKey(key) });
  }

  async resetAll(): Promise<void> {
    await RateLimitCounterModel.deleteMany({ namespace: this.namespace });
  }
}

export function createMongoRateLimitStore(namespace: string): MongoRateLimitStore {
  return new MongoRateLimitStore(namespace);
}

/** Create/validate the unique allocation and TTL indexes before accepting production traffic. */
export async function ensureRateLimitStoreReady(): Promise<void> {
  await RateLimitCounterModel.init();
}
