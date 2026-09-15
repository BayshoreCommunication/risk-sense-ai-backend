/**
 * Single error vocabulary for the API. The frontend switches on `code`, never on `message`.
 * See docs/ai/API.md "Envelope".
 */
export const ErrorCodes = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  SESSION_INVALID: 401,
  OTP_REQUIRED: 401,
  OTP_INVALID: 401,
  OTP_EXPIRED: 401,
  SSO_REQUIRED: 401,
  OTP_RATE_LIMITED: 429,
  MAIL_SEND_FAILED: 502,
  FORBIDDEN: 403,
  MFA_REQUIRED: 403,
  FEATURE_DISABLED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CONCURRENT_LOGIN_BLOCKED: 409,
  ROLE_CONFLICT: 422,
  NO_LINKED_QUESTIONS: 422,
  MISSING_REQUIRED_FACTS: 422,
  NOT_APPROVED: 422,
  SELF_APPROVAL: 422,
  OVERRIDE_REASON_TOO_SHORT: 422,
  DECISION_REQUIRED: 422,
  AUDIT_CHAIN_BROKEN: 500,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = ErrorCodes[code];
    this.details = details;
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
