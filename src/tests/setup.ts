/**
 * Test bootstrap: one in-memory single-node replica set for the whole run, fresh database per test file.
 * Uses the Homebrew mongod binary when present so nothing is downloaded on this Mac.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.AUTH_DEV_BYPASS = 'true';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.MAIL_PROVIDER = 'console'; // tests never send real mail, whatever .env says
process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/unused'; // replaced by the in-memory server below
for (const bin of ['/opt/homebrew/bin/mongod', '/usr/local/bin/mongod']) {
  if (!process.env.MONGOMS_SYSTEM_BINARY && existsSync(bin)) process.env.MONGOMS_SYSTEM_BINARY = bin;
}

import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongod: MongoMemoryReplSet;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({
    instanceOpts: [{ launchTimeout: 30_000 }],
    replSet: { count: 1, dbName: 'risksense_test', storageEngine: 'wiredTiger' },
  });
  process.env.MONGODB_URI = mongod.getUri();
  await mongoose.connect(process.env.MONGODB_URI);
});

beforeEach(async () => {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
