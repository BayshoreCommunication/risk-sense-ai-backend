import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../../tests/helpers';

describe('GET /api/v1/health', () => {
  it('reports db connected and returns the envelope [NFR-05]', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.db).toBe('connected');
    expect(res.body.meta.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(res.body.meta.requestId);
  });

  it('returns 404 envelope for unknown routes', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
