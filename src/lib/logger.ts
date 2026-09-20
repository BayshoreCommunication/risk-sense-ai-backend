import pino from 'pino';
import { env, isProd, isTest } from '../config/env';

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  // Pretty output locally; JSON in production so platform log tools can parse it.
  transport: isProd ? undefined : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
  redact: ['req.headers.authorization', 'req.headers["x-session-id"]'],
});
