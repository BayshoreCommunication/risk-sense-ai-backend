import { describe, expect, it } from 'vitest';
import { createMongoReadinessGate } from './db';

describe('serverless Mongo readiness', () => {
  it('reconnects after a completed connection later becomes disconnected [NFR-05]', async () => {
    let connected = false;
    let attempts = 0;
    let releaseFirstAttempt: (() => void) | undefined;
    const firstAttemptBlocked = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    const ready = createMongoReadinessGate(
      async () => {
        attempts += 1;
        if (attempts === 1) await firstAttemptBlocked;
        connected = true;
      },
      () => connected,
    );

    const first = ready();
    const concurrent = ready();
    await Promise.resolve();
    expect(attempts).toBe(1);
    releaseFirstAttempt!();
    await Promise.all([first, concurrent]);

    connected = false;
    await ready();

    expect(attempts).toBe(2);
  });

  it('clears a failed attempt so the existing cold-start retry can connect [NFR-05]', async () => {
    let connected = false;
    let attempts = 0;
    const ready = createMongoReadinessGate(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient connection failure');
        connected = true;
      },
      () => connected,
    );

    await expect(ready()).rejects.toThrow('transient connection failure');
    await ready();

    expect(attempts).toBe(2);
    expect(connected).toBe(true);
  });

  it('re-runs full preparation when Mongo connects but a later readiness step fails [NFR-05]', async () => {
    let connected = false;
    let attempts = 0;
    const ready = createMongoReadinessGate(
      async () => {
        attempts += 1;
        connected = true;
        if (attempts === 1) throw new Error('rate-limit index validation failed');
      },
      () => connected,
    );

    await expect(ready()).rejects.toThrow('rate-limit index validation failed');
    await ready();

    expect(attempts).toBe(2);
    expect(connected).toBe(true);
  });
});
