/**
 * npm run openapi — emits openapi.json from Zod schemas (DecisionLog 2026-09-13-06).
 * Only the routes implemented so far are registered; add a `registry.registerPath` per new route.
 */
import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { ROLES } from '../modules/users/model';
import { TENANT_PLANS } from '../modules/tenants/model';
import { ListAuditQuery } from '../modules/audit/routes';
import { CreateSessionBody } from '../modules/auth/routes';

extendZodWithOpenApi(z);
const registry = new OpenAPIRegistry();

const Envelope = (data: z.ZodTypeAny) => z.object({ data, meta: z.object({ requestId: z.string() }) });
const ErrorEnvelope = z
  .object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }), meta: z.object({ requestId: z.string() }) })
  .openapi('ErrorEnvelope');

const AuthUser = z
  .object({
    id: z.string(),
    firebaseUid: z.string(),
    email: z.string().email(),
    name: z.string(),
    role: z.enum(ROLES),
    tenantId: z.string(),
    departmentIds: z.array(z.string()),
    crossDepartmentAccess: z.boolean(),
    mfaEnrolled: z.boolean(),
  })
  .openapi('AuthUser');

const AuthTenant = z
  .object({
    id: z.string(),
    slug: z.string(),
    plan: z.enum(TENANT_PLANS),
    features: z.object({
      sso: z.boolean(),
      reviewDashboard: z.boolean(),
      reports: z.boolean(),
      fullAudit: z.boolean(),
      departmentMapping: z.boolean(),
      blockConcurrentLogin: z.boolean(),
    }),
    sessionPolicy: z.object({ idleTimeoutMin: z.number(), maxConcurrentSessions: z.number() }),
  })
  .openapi('AuthTenant');

const bearer = registry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer' });
const sessionHeader = registry.registerComponent('securitySchemes', 'sessionId', { type: 'apiKey', in: 'header', name: 'X-Session-Id' });

registry.registerPath({
  method: 'get',
  path: '/health',
  responses: {
    200: {
      description: 'Service health',
      content: {
        'application/json': {
          schema: Envelope(
            z.object({ status: z.string(), db: z.string(), openai: z.string(), auth: z.string(), version: z.string(), uptimeSec: z.number() }),
          ),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/otp/request',
  security: [{ [bearer.name]: [] }],
  responses: {
    200: {
      description: 'Code emailed (devCode only outside production with the console mail provider)',
      content: {
        'application/json': {
          schema: Envelope(z.object({ sentTo: z.string(), expiresAt: z.string().datetime(), devCode: z.string().optional() })),
        },
      },
    },
    429: { description: 'OTP_RATE_LIMITED', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/session',
  security: [{ [bearer.name]: [] }],
  request: { body: { content: { 'application/json': { schema: CreateSessionBody } } } },
  responses: {
    201: {
      description: 'Session created',
      content: {
        'application/json': {
          schema: Envelope(z.object({ sessionId: z.string(), expiresAt: z.string().datetime(), user: AuthUser, tenant: AuthTenant })),
        },
      },
    },
    401: { description: 'UNAUTHENTICATED | OTP_REQUIRED | OTP_INVALID | OTP_EXPIRED', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: { description: 'CONCURRENT_LOGIN_BLOCKED', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/auth/session',
  security: [{ [bearer.name]: [], [sessionHeader.name]: [] }],
  responses: { 200: { description: 'Logged out', content: { 'application/json': { schema: Envelope(z.object({ loggedOut: z.boolean() })) } } } },
});

registry.registerPath({
  method: 'get',
  path: '/me',
  security: [{ [bearer.name]: [], [sessionHeader.name]: [] }],
  responses: {
    200: {
      description: 'Current user',
      content: { 'application/json': { schema: Envelope(z.object({ user: AuthUser, tenant: AuthTenant, sessionId: z.string() })) } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/audit-logs',
  security: [{ [bearer.name]: [], [sessionHeader.name]: [] }],
  request: { query: ListAuditQuery },
  responses: {
    200: {
      description: 'Audit entries (newest first)',
      content: { 'application/json': { schema: Envelope(z.object({ items: z.array(z.record(z.unknown())), nextCursorSeq: z.number().nullable() })) } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/audit-logs/verify',
  security: [{ [bearer.name]: [], [sessionHeader.name]: [] }],
  responses: {
    200: {
      description: 'Hash chain verification',
      content: { 'application/json': { schema: Envelope(z.object({ ok: z.boolean(), checked: z.number(), firstBadSeq: z.number().optional() })) } },
    },
  },
});

const doc = new OpenApiGeneratorV3(registry.definitions).generateDocument({
  openapi: '3.0.3',
  info: { title: 'RiskSense AI API', version: '0.1.0', description: 'Generated from Zod schemas. See docs/ai/API.md.' },
  servers: [{ url: '/api/v1' }],
});

writeFileSync('openapi.json', JSON.stringify(doc, null, 2));
console.log(`openapi.json written (${Object.keys(doc.paths ?? {}).length} paths)`);
