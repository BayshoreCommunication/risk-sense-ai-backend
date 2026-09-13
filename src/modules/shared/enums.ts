/** Vocabulary shared by content, rules, scoring and assessments. Keep in sync with docs/ai/AI_MEMORY.md. */
export const CLASSIFICATIONS = ['monitor_only', 'risk', 'elevated_risk', 'issue'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const CONTENT_SECTORS = ['financial', 'healthcare', 'it', 'general'] as const;
export type ContentSector = (typeof CONTENT_SECTORS)[number];

export const QUESTION_TYPES = ['mcq', 'yes_no', 'free_text', 'number'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const VERSION_STATUSES = ['draft', 'active', 'deactivated'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/** snake_case keys used by personas, scenarios, questions and facts. */
export const KEY_REGEX = /^[a-z][a-z0-9_]{1,63}$/;
