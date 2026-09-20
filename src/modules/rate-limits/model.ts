import { model, models, Schema } from 'mongoose';

export interface RateLimitCounter {
  namespace: string;
  keyHash: string;
  hits: number;
  resetAt: Date;
}

const RateLimitCounterSchema = new Schema<RateLimitCounter>(
  {
    namespace: { type: String, required: true },
    // Caller keys can contain session ids, IP addresses or a development identity. Persist only a
    // one-way digest; the namespace keeps otherwise-identical keys in independent limiter budgets.
    keyHash: { type: String, required: true },
    hits: { type: Number, required: true, min: 0 },
    resetAt: { type: Date, required: true },
  },
  { collection: 'rateLimitCounters', versionKey: false },
);

RateLimitCounterSchema.index({ namespace: 1, keyHash: 1 }, { unique: true });
// TTL cleanup is storage hygiene, not enforcement. The store compares resetAt atomically on every
// increment because MongoDB's TTL monitor is intentionally asynchronous.
RateLimitCounterSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimitCounterModel =
  models.RateLimitCounter ?? model<RateLimitCounter>('RateLimitCounter', RateLimitCounterSchema);
