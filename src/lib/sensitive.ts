import type { AuthUser } from '../middleware/auth';

/**
 * SEC-05 — sensitive data classes and masking.
 *
 * Registry of fields that carry personal, health or financial information. Non-privileged views mask them;
 * `?unmask=true` returns the clear values for administrator / system_administrator / audit and writes an
 * `access.unmasked` audit entry (the access itself is logged). Requestors who may act on an assessment
 * (owner, department reviewer, escalatee) always see it in clear — they cannot decide on masked facts.
 * Exports (reports CSV/PDF) never contain any registered field — they are aggregates by construction.
 */
export type SensitiveClass = 'pii' | 'phi' | 'financial';

export const SENSITIVE_FIELDS: { collection: string; path: string; class: SensitiveClass | 'by-sector'; note: string }[] = [
  { collection: 'users', path: 'email', class: 'pii', note: 'identity' },
  { collection: 'users', path: 'name', class: 'pii', note: 'identity' },
  { collection: 'assessments', path: 'openingText', class: 'by-sector', note: 'free-text incident description' },
  { collection: 'assessments', path: 'answers[].text', class: 'by-sector', note: 'free-text answers' },
  { collection: 'assessments', path: 'facts[].value (source=ai)', class: 'by-sector', note: 'values extracted from free text' },
  { collection: 'assessments', path: 'facts[].evidence', class: 'by-sector', note: 'verbatim answer fragment' },
  { collection: 'assessments', path: 'decision.reason', class: 'pii', note: 'override / escalation reason' },
  { collection: 'assessmentMessages', path: 'content (role=user)', class: 'by-sector', note: 'transcript, user turns' },
  { collection: 'auditLogs', path: 'payload.* (fullAudit)', class: 'by-sector', note: 'PAID payloads copy the above' },
];

/** Healthcare content is PHI, financial content is financial data, everything else is PII (SEC-05, SEC-08). */
export function classFor(sector?: string | null): SensitiveClass {
  return sector === 'healthcare' ? 'phi' : sector === 'financial' ? 'financial' : 'pii';
}

export const MASK = '•••';

/** Keeps the shape recognisable without leaking content: first character + length. */
export function maskText(v: unknown): unknown {
  if (typeof v !== 'string' || v.length === 0) return v;
  if (/^[^@\s]+@[^@\s]+$/.test(v)) return `${v[0]}${MASK}@${v.split('@')[1]}`; // email: keep the domain
  return `${v[0]}${MASK} (${v.length} chars)`;
}

/** Readers of the tenant that do not act on the record: masked unless they explicitly (and audibly) unmask. */
export function isPrivilegedReader(user: AuthUser): boolean {
  return user.role === 'administrator' || user.role === 'system_administrator' || user.role === 'audit';
}

/** Assessment view / list row masking for a non-acting reader. Pure: returns a new object. */
export function maskAssessmentView<T extends Record<string, unknown>>(view: T, sector?: string | null): T & { masked: SensitiveClass } {
  const cls = classFor(sector);
  const out: Record<string, unknown> = { ...view, masked: cls };
  if ('openingText' in out) out.openingText = maskText(out.openingText);
  if (Array.isArray(out.facts)) out.facts = (out.facts as { source?: string; value?: unknown; evidence?: unknown }[]).map((f) => ({ ...f, value: f.source === 'ai' ? maskText(f.value) : f.value, evidence: f.evidence === undefined ? undefined : maskText(f.evidence) }));
  if (Array.isArray(out.answers)) out.answers = (out.answers as { text?: unknown }[]).map((a) => ({ ...a, text: a.text === undefined ? undefined : maskText(a.text) }));
  if (out.decision && typeof out.decision === 'object' && (out.decision as { reason?: unknown }).reason !== undefined) out.decision = { ...(out.decision as object), reason: maskText((out.decision as { reason?: unknown }).reason) };
  if (out.requestor && typeof out.requestor === 'object' && (out.requestor as { email?: unknown }).email) out.requestor = { ...(out.requestor as object), email: maskText((out.requestor as { email?: unknown }).email) };
  return out as T & { masked: SensitiveClass };
}

export function maskMessages<T extends { role: string; content: string }>(messages: T[], sector?: string | null): (T & { masked?: SensitiveClass })[] {
  const cls = classFor(sector);
  return messages.map((m) => (m.role === 'user' ? { ...m, content: String(maskText(m.content)), masked: cls } : m));
}
