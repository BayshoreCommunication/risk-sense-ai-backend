import { describe, expect, it } from 'vitest';
import { assertDevelopmentDatabase } from './db';

describe('destructive seed database guard', () => {
  it('allows local and *_dev / *_test databases [FR-24]', () => {
    expect(() => assertDevelopmentDatabase('seed:showcase', { name: 'risksense', host: '127.0.0.1' })).not.toThrow();
    expect(() => assertDevelopmentDatabase('seed:showcase', { name: 'risksense_dev', host: 'ac-1.quhyyzp.mongodb.net' })).not.toThrow();
    expect(() => assertDevelopmentDatabase('seed:showcase', { name: 'risksense_test', host: 'ac-1.example.mongodb.net' })).not.toThrow();
  });

  it('refuses a remote production-named database even with NODE_ENV=development [FR-24]', () => {
    expect(() => assertDevelopmentDatabase('seed:showcase', { name: 'risksense', host: 'ac-sn3zdon-shard-00-00.smamzbx.mongodb.net' })).toThrow(
      /seed:showcase refuses database "risksense"/,
    );
    expect(() => assertDevelopmentDatabase('seed:demo', { name: 'risksense_devops', host: 'remote.example.net' })).toThrow();
    expect(() => assertDevelopmentDatabase('seed:demo', { name: 'test', host: 'remote.example.net' })).toThrow();
  });
});
