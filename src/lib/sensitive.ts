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
  { collection: 'assessments', path: 'result.explanation', class: 'by-sector', note: 'AI prose can repeat submitted details' },
  { collection: 'assessments', path: 'decision.reason', class: 'pii', note: 'override / escalation reason' },
  { collection: 'assessmentMessages', path: 'content (role=user or role=assistant, kind=result)', class: 'by-sector', note: 'transcript user turns and result prose' },
  { collection: 'auditLogs', path: 'payload.* (fullAudit)', class: 'by-sector', note: 'PAID payloads copy the above' },
];

/** Healthcare content is PHI, financial content is financial data, everything else is PII (SEC-05, SEC-08). */
export function classFor(sector?: string | null): SensitiveClass {
  return sector === 'healthcare' ? 'phi' : sector === 'financial' ? 'financial' : 'pii';
}

export const MASK = '•••';

/** Keeps the shape recognisable without leaking content: first character + length. */
export function maskText(v: unknown): unknown {
  if (v === null || v === undefined || v === '') return v;
  if (typeof v !== 'string') return MASK;
  if (/^[^@\s]+@[^@\s]+$/.test(v)) return `${v[0]}${MASK}@${v.split('@')[1]}`; // email: keep the domain
  return `${v[0]}${MASK} (${v.length} chars)`;
}

/**
 * Masks the registered sensitive shapes copied into full-audit payloads without changing the stored,
 * hash-chained record. This intentionally operates on a response copy (SEC-05 + SEC-07).
 */
export function maskAuditPayload(payload: unknown): unknown {
  const maskFacts = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((fact) => {
        if (!fact || typeof fact !== 'object') return maskText(fact);
        const out = { ...(fact as Record<string, unknown>) };
        if ('value' in out) out.value = maskText(out.value);
        if ('evidence' in out) out.evidence = maskText(out.evidence);
        return out;
      });
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, fact]) => [key, maskText(fact)]));
    }
    return maskText(value);
  };

  const maskAnswers = (value: unknown): unknown => {
    if (!Array.isArray(value)) return maskText(value);
    return value.map((answer) => {
      if (!answer || typeof answer !== 'object') return maskText(answer);
      const out = { ...(answer as Record<string, unknown>) };
      for (const key of ['answer', 'text', 'value']) if (key in out) out[key] = maskText(out[key]);
      return out;
    });
  };

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'facts') out[key] = maskFacts(child);
      else if (key === 'answers') out[key] = maskAnswers(child);
      else if (['openingText', 'answer', 'reason', 'evidence', 'explanation', 'email', 'name'].includes(key)) out[key] = maskText(child);
      else out[key] = visit(child);
    }
    return out;
  };

  return visit(payload);
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
  if (out.result && typeof out.result === 'object' && (out.result as { explanation?: unknown }).explanation !== undefined) out.result = { ...(out.result as object), explanation: maskText((out.result as { explanation?: unknown }).explanation) };
  if (out.requestor && typeof out.requestor === 'object') {
    const requestor = { ...(out.requestor as Record<string, unknown>) };
    if ('name' in requestor) requestor.name = maskText(requestor.name);
    if ('email' in requestor) requestor.email = maskText(requestor.email);
    out.requestor = requestor;
  }
  if (out.escalatedTo && typeof out.escalatedTo === 'object') {
    const escalatedTo = { ...(out.escalatedTo as Record<string, unknown>) };
    if ('name' in escalatedTo) escalatedTo.name = maskText(escalatedTo.name);
    if ('email' in escalatedTo) escalatedTo.email = maskText(escalatedTo.email);
    out.escalatedTo = escalatedTo;
  }
  return out as T & { masked: SensitiveClass };
}

export function maskMessages<T extends { role: string; kind?: string; content: string }>(messages: T[], sector?: string | null): (T & { masked?: SensitiveClass })[] {
  const cls = classFor(sector);
  return messages.map((m) => (m.role === 'user' || (m.role === 'assistant' && m.kind === 'result') ? { ...m, content: String(maskText(m.content)), masked: cls } : m));
}
