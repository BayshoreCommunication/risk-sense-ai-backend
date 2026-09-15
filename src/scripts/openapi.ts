/**
 * npm run openapi — emits openapi.json from Zod schemas (DecisionLog 2026-09-13-06).
 * Only the routes implemented so far are registered; add a `registry.registerPath` per new route.
 */
import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { ROLES } from '../modules/users/model';
import { TENANT_PLANS } from '../modules/tenants/model';
import { ArchiveAuditBody, ListAuditQuery } from '../modules/audit/routes';
import { CreateSessionBody, SsoLookupQuery } from '../modules/auth/routes';
import { ConformanceFlagsQuery, DrStatusPatch, SystemDepartmentCreate, SystemDepartmentPatch, SystemIdParams, SystemUserCreate, SystemUserPatch, TenantPatch } from '../modules/system/schema';
import { RunBody as RetentionRunBody } from '../modules/retention/routes';
import { PersonaBody, PersonaListQuery, PersonaPatch } from '../modules/personas/schema';
import { ScenarioBody, ScenarioListQuery, ScenarioPatch } from '../modules/scenarios/schema';
import { QuestionBody, QuestionListQuery, QuestionPatch } from '../modules/questions/schema';
import { JsonUploadBody } from '../modules/datasets/routes';
import { RuleBody, RuleListQuery, RulePatch, ApproveBody as RuleApproveBody } from '../modules/rules/schema';
import { MatrixBody, MatrixListQuery, MatrixPatch, SimulateBody } from '../modules/scoring/schema';
import { ExportQuery, ReportParams, ReportQuery, TrendsQuery } from '../modules/reports/schema';
import { DecisionBody, ListQuery as AssessmentListQuery, MessageBody, PersonaBody as AssessmentPersonaBody, StartBody, UnmaskQuery } from '../modules/assessments/schema';

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
          schema: Envelope(z.object({ status: z.string(), db: z.string(), openai: z.string(), auth: z.string(), mail: z.string(), version: z.string(), uptimeSec: z.number() })),
        },
      },
    },
  },
});
registry.registerPath({ method: 'get', path: '/health/live', responses: { 200: { description: 'Process liveness (no dependency checks)', content: { 'application/json': { schema: Envelope(z.object({ status: z.literal('ok'), uptimeSec: z.number() })) } } } } });
registry.registerPath({ method: 'get', path: '/health/ready', responses: { 200: { description: 'Database readiness with a live ping', content: { 'application/json': { schema: Envelope(z.object({ status: z.literal('ok'), db: z.literal('connected'), dbPingMs: z.number() })) } } }, 503: { description: 'Database is not ready', content: { 'application/json': { schema: Envelope(z.object({ status: z.literal('degraded'), db: z.string(), dbPingMs: z.number() })) } } } } });

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
    401: { description: 'UNAUTHENTICATED | SSO_REQUIRED | OTP_REQUIRED | OTP_INVALID | OTP_EXPIRED', content: { 'application/json': { schema: ErrorEnvelope } } },
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
registry.registerPath({ method: 'post', path: '/audit-logs/archive', security: [{ [bearer.name]: [], [sessionHeader.name]: [] }], request: { body: { content: { 'application/json': { schema: ArchiveAuditBody } } } }, responses: { 201: { description: 'Bounded clear-text audit export plus immutable manifest/hash (system_administrator, fullAudit)', content: { 'application/json': { schema: Envelope(z.object({ manifest: z.record(z.unknown()), records: z.array(z.record(z.unknown())) })) } } } } });
registry.registerPath({ method: 'get', path: '/audit-logs/archive-manifests', security: [{ [bearer.name]: [], [sessionHeader.name]: [] }], responses: { 200: { description: 'Immutable audit cold-storage export manifests', content: { 'application/json': { schema: Envelope(z.array(z.record(z.unknown()))) } } } } });

// ---- Content modules (personas, scenarios, questions) — Phase 2
const Any = z.record(z.unknown());
const secured = [{ [bearer.name]: [], [sessionHeader.name]: [] }];
function registerContent(base: string, name: string, body: z.ZodTypeAny, patch: z.ZodTypeAny, query: z.AnyZodObject, extra: { versioned: boolean }) {
  const Item = Any.openapi(name);
  registry.registerPath({ method: 'get', path: base, security: secured, request: { query }, responses: { 200: { description: `List ${name}s`, content: { 'application/json': { schema: Envelope(z.array(Item)) } } } } });
  registry.registerPath({ method: 'post', path: base, security: secured, request: { body: { content: { 'application/json': { schema: body } } } }, responses: { 201: { description: `${name} created (draft)`, content: { 'application/json': { schema: Envelope(Item) } } }, 409: { description: 'CONFLICT (duplicate key)', content: { 'application/json': { schema: ErrorEnvelope } } } } });
  registry.registerPath({ method: 'get', path: `${base}/{id}`, security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: name, content: { 'application/json': { schema: Envelope(Item) } } } } });
  registry.registerPath({ method: 'patch', path: `${base}/{id}`, security: secured, request: { params: z.object({ id: z.string() }), body: { content: { 'application/json': { schema: patch } } } }, responses: { 200: { description: extra.versioned ? 'Draft updated in place, or a new draft version created' : 'Updated', content: { 'application/json': { schema: Envelope(Item) } } } } });
  if (extra.versioned) {
    registry.registerPath({ method: 'get', path: `${base}/{id}/history`, security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'All versions, newest first', content: { 'application/json': { schema: Envelope(z.array(Item)) } } } } });
    registry.registerPath({ method: 'post', path: `${base}/{id}/activate`, security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Activated', content: { 'application/json': { schema: Envelope(Item) } } }, 422: { description: 'NO_LINKED_QUESTIONS / validation', content: { 'application/json': { schema: ErrorEnvelope } } } } });
    registry.registerPath({ method: 'post', path: `${base}/{id}/deactivate`, security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deactivated', content: { 'application/json': { schema: Envelope(Item) } } } } });
  } else {
    registry.registerPath({ method: 'post', path: `${base}/{id}/retire`, security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Retired', content: { 'application/json': { schema: Envelope(Item) } } } } });
  }
}
registerContent('/personas', 'Persona', PersonaBody, PersonaPatch, PersonaListQuery, { versioned: true });
registerContent('/scenarios', 'Scenario', ScenarioBody, ScenarioPatch, ScenarioListQuery, { versioned: true });
registerContent('/questions', 'Question', QuestionBody, QuestionPatch, QuestionListQuery, { versioned: false });

// ---- Datasets (T-024)
const Dataset = Any.openapi('Dataset');
registry.registerPath({ method: 'get', path: '/datasets/template', security: secured, responses: { 200: { description: 'XLSX content template', content: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: z.string().openapi({ format: 'binary' }) } } } } });
registry.registerPath({ method: 'get', path: '/datasets', security: secured, responses: { 200: { description: 'Uploads, newest first (without content)', content: { 'application/json': { schema: Envelope(z.array(Dataset)) } } } } });
registry.registerPath({
  method: 'post',
  path: '/datasets',
  security: secured,
  request: { body: { content: { 'application/json': { schema: JsonUploadBody }, 'multipart/form-data': { schema: z.object({ file: z.string().openapi({ format: 'binary' }) }) } } } },
  responses: { 201: { description: 'Stored as validated or rejected (with validationErrors); nothing applied', content: { 'application/json': { schema: Envelope(Dataset) } } } },
});
registry.registerPath({ method: 'get', path: '/datasets/{id}', security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Dataset with content', content: { 'application/json': { schema: Envelope(Dataset) } } } } });
registry.registerPath({ method: 'post', path: '/datasets/{id}/approve', security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Approved by a different administrator', content: { 'application/json': { schema: Envelope(Dataset) } } }, 422: { description: 'SELF_APPROVAL', content: { 'application/json': { schema: ErrorEnvelope } } } } });
registry.registerPath({ method: 'post', path: '/datasets/{id}/activate', security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Applied: personas, questions, scenarios created/versioned and activated', content: { 'application/json': { schema: Envelope(Dataset) } } }, 422: { description: 'NOT_APPROVED', content: { 'application/json': { schema: ErrorEnvelope } } } } });

// ---- Rules (T-025) and scoring matrices (T-026)
const Rule = Any.openapi('Rule');
registry.registerPath({ method: 'get', path: '/rules', security: secured, request: { query: RuleListQuery }, responses: { 200: { description: 'Rules by priority', content: { 'application/json': { schema: Envelope(z.array(Rule)) } } } } });
registry.registerPath({ method: 'post', path: '/rules', security: secured, request: { body: { content: { 'application/json': { schema: RuleBody } } } }, responses: { 201: { description: 'Draft rule', content: { 'application/json': { schema: Envelope(Rule) } } } } });
registry.registerPath({ method: 'get', path: '/rules/{id}', security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Rule', content: { 'application/json': { schema: Envelope(Rule) } } } } });
registry.registerPath({ method: 'get', path: '/rules/{id}/history', security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'All versions in the logical rule group, newest first', content: { 'application/json': { schema: Envelope(z.array(Rule)) } } } } });
registry.registerPath({ method: 'patch', path: '/rules/{id}', security: secured, request: { params: z.object({ id: z.string() }), body: { content: { 'application/json': { schema: RulePatch } } } }, responses: { 200: { description: 'Updated (back to draft)', content: { 'application/json': { schema: Envelope(Rule) } } } } });
registry.registerPath({ method: 'post', path: '/rules/{id}/approve', security: secured, request: { params: z.object({ id: z.string() }), body: { content: { 'application/json': { schema: RuleApproveBody } } } }, responses: { 200: { description: 'Approved', content: { 'application/json': { schema: Envelope(Rule) } } }, 422: { description: 'SELF_APPROVAL', content: { 'application/json': { schema: ErrorEnvelope } } } } });
registry.registerPath({ method: 'post', path: '/rules/{id}/activate', security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Active', content: { 'application/json': { schema: Envelope(Rule) } } }, 422: { description: 'NOT_APPROVED', content: { 'application/json': { schema: ErrorEnvelope } } } } });
registry.registerPath({ method: 'post', path: '/rules/{id}/retire', security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Retired', content: { 'application/json': { schema: Envelope(Rule) } } } } });

const Matrix = Any.openapi('ScoringMatrix');
registry.registerPath({ method: 'get', path: '/scoring-matrices', security: secured, request: { query: MatrixListQuery }, responses: { 200: { description: 'Matrices', content: { 'application/json': { schema: Envelope(z.array(Matrix)) } } } } });
registry.registerPath({ method: 'post', path: '/scoring-matrices', security: secured, request: { body: { content: { 'application/json': { schema: MatrixBody } } } }, responses: { 201: { description: 'Draft matrix', content: { 'application/json': { schema: Envelope(Matrix) } } } } });
registry.registerPath({ method: 'get', path: '/scoring-matrices/{id}', security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Matrix', content: { 'application/json': { schema: Envelope(Matrix) } } } } });
registry.registerPath({ method: 'get', path: '/scoring-matrices/{id}/history', security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Versions', content: { 'application/json': { schema: Envelope(z.array(Matrix)) } } } } });
registry.registerPath({ method: 'patch', path: '/scoring-matrices/{id}', security: secured, request: { params: z.object({ id: z.string() }), body: { content: { 'application/json': { schema: MatrixPatch } } } }, responses: { 200: { description: 'Draft updated or new draft version (approval cleared)', content: { 'application/json': { schema: Envelope(Matrix) } } } } });
registry.registerPath({ method: 'post', path: '/scoring-matrices/{id}/approve', security: secured, request: { params: z.object({ id: z.string() }), body: { content: { 'application/json': { schema: RuleApproveBody } } } }, responses: { 200: { description: 'Approved', content: { 'application/json': { schema: Envelope(Matrix) } } }, 422: { description: 'SELF_APPROVAL', content: { 'application/json': { schema: ErrorEnvelope } } } } });
registry.registerPath({ method: 'post', path: '/scoring-matrices/{id}/activate', security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Active + current', content: { 'application/json': { schema: Envelope(Matrix) } } }, 422: { description: 'NOT_APPROVED', content: { 'application/json': { schema: ErrorEnvelope } } } } });
registry.registerPath({ method: 'post', path: '/scoring-matrices/{id}/deactivate', security: secured, request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Deactivated', content: { 'application/json': { schema: Envelope(Matrix) } } } } });
registry.registerPath({ method: 'post', path: '/scoring/simulate', security: secured, request: { body: { content: { 'application/json': { schema: SimulateBody } } } }, responses: { 200: { description: 'Score, factors, classification, confidence, rule result', content: { 'application/json': { schema: Envelope(Any) } } } } });

// ---- Assessments (Phase 3)
const Assessment = Any.openapi('Assessment');
const Turn = Any.openapi('AssessmentTurn'); // assessment view + { nextQuestion, intakeComplete, missingRequired }
const idp = z.object({ id: z.string() });
registry.registerPath({ method: 'post', path: '/assessments', security: secured, request: { body: { content: { 'application/json': { schema: StartBody } } } }, responses: { 201: { description: 'Started; a user-selected persona continues, while an AI proposal pauses for explicit confirmation or override before scenario questions', content: { 'application/json': { schema: Envelope(Turn) } } } } });
const AssessmentListItem = Any.openapi('AssessmentListItem'); // list row: status, keys, result summary, decision, requestor {name,email}, department {name}
const AssessmentCounts = z.object({ in_progress: z.number(), intake_complete: z.number(), awaiting_decision: z.number(), escalated: z.number(), closed: z.number(), error_review: z.number(), pending: z.number(), all: z.number() }).openapi('AssessmentCounts');
registry.registerPath({ method: 'get', path: '/assessments', security: secured, request: { query: AssessmentListQuery }, responses: { 200: { description: 'Review dashboard (DASH-01): scoped, filtered, paginated; counts per status within the non-status filters', content: { 'application/json': { schema: Envelope(z.object({ items: z.array(AssessmentListItem), total: z.number(), page: z.number(), limit: z.number(), pages: z.number(), counts: AssessmentCounts })) } } } } });
registry.registerPath({ method: 'get', path: '/departments', security: secured, responses: { 200: { description: "The caller's tenant departments (filter lookup; FR-10)", content: { 'application/json': { schema: Envelope(z.array(z.object({ _id: z.string(), name: z.string(), personaIds: z.array(z.string()) }).openapi('Department'))) } } } } });
registry.registerPath({ method: 'get', path: '/assessments/{id}', security: secured, request: { params: idp, query: UnmaskQuery }, responses: { 200: { description: 'Assessment', content: { 'application/json': { schema: Envelope(Assessment) } } } } });
registry.registerPath({ method: 'get', path: '/assessments/{id}/messages', security: secured, request: { params: idp, query: UnmaskQuery }, responses: { 200: { description: 'Transcript', content: { 'application/json': { schema: Envelope(z.array(Any)) } } } } });
registry.registerPath({ method: 'post', path: '/assessments/{id}/persona', security: secured, request: { params: idp, body: { content: { 'application/json': { schema: AssessmentPersonaBody } } } }, responses: { 200: { description: 'Persona set/overridden', content: { 'application/json': { schema: Envelope(Turn) } } } } });
registry.registerPath({ method: 'post', path: '/assessments/{id}/messages', security: secured, request: { params: idp, body: { content: { 'application/json': { schema: MessageBody } } } }, responses: { 200: { description: 'Answer recorded; next question or intakeComplete', content: { 'application/json': { schema: Envelope(Turn) } } } } });
registry.registerPath({ method: 'post', path: '/assessments/{id}/submit', security: secured, request: { params: idp }, responses: { 200: { description: 'Result computed (rules → scoring → explanation)', content: { 'application/json': { schema: Envelope(Assessment) } } }, 422: { description: 'MISSING_REQUIRED_FACTS', content: { 'application/json': { schema: ErrorEnvelope } } } } });
registry.registerPath({ method: 'get', path: '/assessments/{id}/reconstruct', security: secured, request: { params: idp, query: UnmaskQuery }, responses: { 200: { description: 'FR-26: lifecycle rebuilt from the audit log (timeline, state, completeness, integrity, conformance)', content: { 'application/json': { schema: Envelope(Any.openapi('AssessmentReconstruction')) } } } } });
registry.registerPath({ method: 'get', path: '/assessments/{id}/escalation-targets', security: secured, request: { params: idp }, responses: { 200: { description: 'Reviewers the caller may escalate to (T-061; empty on FREE)', content: { 'application/json': { schema: Envelope(z.array(z.object({ _id: z.string(), name: z.string(), email: z.string(), departmentIds: z.array(z.string()), crossDepartmentAccess: z.boolean() }).openapi('EscalationTarget'))) } } } } });
registry.registerPath({ method: 'post', path: '/assessments/{id}/decision', security: secured, request: { params: idp, body: { content: { 'application/json': { schema: DecisionBody } } } }, responses: { 200: { description: 'Decision recorded; closed or escalated', content: { 'application/json': { schema: Envelope(Assessment) } } } } });

const ReportResult = z.object({ type: z.string(), params: z.record(z.unknown()), range: z.object({ from: z.string(), to: z.string(), interval: z.string() }), generatedAt: z.string(), cached: z.boolean(), computeMs: z.number(), columns: z.array(z.object({ key: z.string(), label: z.string(), kind: z.enum(['text', 'number', 'percent', 'seconds']) })), rows: z.array(z.record(z.union([z.string(), z.number(), z.null()]))), summary: z.record(z.union([z.string(), z.number(), z.null()])) }).openapi('ReportResult');
registry.registerPath({ method: 'get', path: '/reports/{type}', security: secured, request: { params: ReportParams, query: ReportQuery.innerType() }, responses: { 200: { description: 'Standard report (FR-26): volume | classification | override-rate | assessment-time; cached 1 h; PAID reports feature', content: { 'application/json': { schema: Envelope(ReportResult) } } } } });
registry.registerPath({ method: 'get', path: '/reports/{type}/export', security: secured, request: { params: ReportParams, query: ExportQuery }, responses: { 200: { description: 'CSV or PDF of the same rows (FR-28)', content: { 'text/csv': { schema: z.string() }, 'application/pdf': { schema: z.string().openapi({ format: 'binary' }) } } } } });
registry.registerPath({ method: 'get', path: '/analytics/trends', security: secured, request: { query: TrendsQuery }, responses: { 200: { description: 'Trend rows per period × department | persona | scenario (FR-27, DASH-03)', content: { 'application/json': { schema: Envelope(ReportResult) } } } } });

registry.registerPath({ method: 'get', path: '/auth/sso/lookup', request: { query: SsoLookupQuery }, responses: { 200: { description: 'SSO provider for the email domain (FR-03); providerId null when none', content: { 'application/json': { schema: Envelope(z.object({ providerId: z.string().nullable(), tenant: z.string().nullable() })) } } } } });
const TenantSettings = z.object({ _id: z.string(), name: z.string(), slug: z.string(), plan: z.enum(TENANT_PLANS), features: AuthTenant.shape.features, sso: z.object({ providerId: z.string().nullable(), domain: z.string().nullable() }), authPolicy: z.object({ otpRequired: z.boolean() }), sessionPolicy: z.object({ idleTimeoutMin: z.number(), maxConcurrentSessions: z.number() }), retentionPolicy: z.object({ assessmentDays: z.number(), auditDays: z.number(), evidenceDays: z.number(), datasetHistoryDays: z.number() }), updatedAt: z.string().optional() }).openapi('TenantSettings');
registry.registerPath({ method: 'get', path: '/system/tenant', security: secured, responses: { 200: { description: 'Tenant settings (system_administrator)', content: { 'application/json': { schema: Envelope(TenantSettings) } } } } });
registry.registerPath({ method: 'patch', path: '/system/tenant', security: secured, request: { body: { content: { 'application/json': { schema: TenantPatch } } } }, responses: { 200: { description: 'Updated settings; audited as config/tenant.updated', content: { 'application/json': { schema: Envelope(TenantSettings) } } } } });

const SystemUser = z.object({ _id: z.string(), email: z.string().email(), name: z.string(), role: z.enum(ROLES), departmentIds: z.array(z.string()), crossDepartmentAccess: z.boolean(), mfaEnrolled: z.boolean(), status: z.enum(['active', 'disabled']), lastLoginAt: z.string().nullable() }).openapi('SystemUser');
registry.registerPath({ method: 'get', path: '/system/users', security: secured, responses: { 200: { description: 'Tenant users (system_administrator)', content: { 'application/json': { schema: Envelope(z.array(SystemUser)) } } } } });
registry.registerPath({ method: 'post', path: '/system/users', security: secured, request: { body: { content: { 'application/json': { schema: SystemUserCreate } } } }, responses: { 201: { description: 'Pre-provisioned tenant user with exactly one role', content: { 'application/json': { schema: Envelope(SystemUser) } } } } });
registry.registerPath({ method: 'patch', path: '/system/users/{id}', security: secured, request: { params: SystemIdParams, body: { content: { 'application/json': { schema: SystemUserPatch } } } }, responses: { 200: { description: 'User updated; role/status changes terminate active sessions', content: { 'application/json': { schema: Envelope(SystemUser) } } } } });

const SystemDepartment = z.object({ _id: z.string(), name: z.string(), personaIds: z.array(z.string()) }).openapi('SystemDepartment');
const SystemPersona = z.object({ _id: z.string(), key: z.string(), name: z.string(), sector: z.string(), source: z.enum(['tenant', 'shared']) }).openapi('SystemPersona');
registry.registerPath({ method: 'get', path: '/system/personas', security: secured, responses: { 200: { description: 'Effective active persona catalog for department mapping', content: { 'application/json': { schema: Envelope(z.array(SystemPersona)) } } } } });
registry.registerPath({ method: 'get', path: '/system/departments', security: secured, responses: { 200: { description: 'Tenant department/persona mappings', content: { 'application/json': { schema: Envelope(z.array(SystemDepartment)) } } } } });
registry.registerPath({ method: 'post', path: '/system/departments', security: secured, request: { body: { content: { 'application/json': { schema: SystemDepartmentCreate } } } }, responses: { 201: { description: 'Department created', content: { 'application/json': { schema: Envelope(SystemDepartment) } } } } });
registry.registerPath({ method: 'patch', path: '/system/departments/{id}', security: secured, request: { params: SystemIdParams, body: { content: { 'application/json': { schema: SystemDepartmentPatch } } } }, responses: { 200: { description: 'Department/persona mapping updated', content: { 'application/json': { schema: Envelope(SystemDepartment) } } } } });

const DrStatus = z.object({ provider: z.string().nullable(), backupsEnabled: z.boolean(), lastBackupAt: z.string().nullable(), lastRestoreDrillAt: z.string().nullable(), lastRestoreDrillOutcome: z.enum(['passed', 'failed']).nullable(), evidenceRef: z.string().nullable(), targets: z.object({ backupFrequencyHours: z.number(), rpoHours: z.number(), rtoHours: z.number(), drillFrequencyDays: z.number() }), checks: z.object({ backupFresh: z.boolean(), drillCurrent: z.boolean(), externalEvidenceRecorded: z.boolean() }), readiness: z.enum(['ready', 'attention_required']), updatedAt: z.string().nullable() }).openapi('DrStatus');
registry.registerPath({ method: 'get', path: '/system/dr/status', security: secured, responses: { 200: { description: 'External backup/PITR evidence and readiness against NFR-06 targets', content: { 'application/json': { schema: Envelope(DrStatus) } } } } });
registry.registerPath({ method: 'patch', path: '/system/dr/status', security: secured, request: { body: { content: { 'application/json': { schema: DrStatusPatch } } } }, responses: { 200: { description: 'Operator-recorded external DR evidence; audited', content: { 'application/json': { schema: Envelope(DrStatus) } } } } });

const ConformanceRun = z.object({ tenantId: z.string(), slug: z.string(), ranAt: z.string(), trigger: z.string(), scanned: z.number(), valid: z.number(), flagged: z.number(), resolved: z.number(), durationMs: z.number() }).openapi('ConformanceRun');
registry.registerPath({ method: 'post', path: '/system/conformance/run', security: secured, responses: { 200: { description: 'Scan all stored tenant assessments and flag schema/invariant failures (FR-30)', content: { 'application/json': { schema: Envelope(ConformanceRun) } } } } });
registry.registerPath({ method: 'get', path: '/system/conformance/runs', security: secured, responses: { 200: { description: 'Last 30 conformance scans', content: { 'application/json': { schema: Envelope(z.array(ConformanceRun)) } } } } });
registry.registerPath({ method: 'get', path: '/system/conformance/flags', security: secured, request: { query: ConformanceFlagsQuery }, responses: { 200: { description: 'Current or historical assessment conformance flags', content: { 'application/json': { schema: Envelope(z.array(z.record(z.unknown()))) } } } } });

const RetentionRunResult = z.object({ tenantId: z.string(), slug: z.string(), plan: z.string(), dryRun: z.boolean(), policy: z.object({ assessmentDays: z.number(), auditDays: z.number(), evidenceDays: z.number(), datasetHistoryDays: z.number(), graceDays: z.number() }), flagged: z.number(), reduced: z.number(), archived: z.number(), messagesRemoved: z.number(), auditPastRetention: z.number(), durationMs: z.number() }).openapi('RetentionRunResult');
registry.registerPath({ method: 'post', path: '/system/retention/run', security: secured, request: { body: { content: { 'application/json': { schema: RetentionRunBody } } } }, responses: { 200: { description: 'SEC-06: run retention for the tenant (dryRun default true); audited retention.*', content: { 'application/json': { schema: Envelope(RetentionRunResult) } } } } });
registry.registerPath({ method: 'get', path: '/system/retention/runs', security: secured, responses: { 200: { description: 'Last 30 retention runs (retentionRuns)', content: { 'application/json': { schema: Envelope(z.array(RetentionRunResult.extend({ _id: z.string(), ranAt: z.string(), trigger: z.string(), error: z.string().optional() }))) } } } } });

const doc = new OpenApiGeneratorV3(registry.definitions).generateDocument({
  openapi: '3.0.3',
  info: { title: 'RiskSense AI API', version: '0.1.0', description: 'Generated from Zod schemas. See docs/ai/API.md.' },
  servers: [{ url: '/api/v1' }],
});

writeFileSync('openapi.json', JSON.stringify(doc, null, 2));
console.log(`openapi.json written (${Object.keys(doc.paths ?? {}).length} paths)`);
