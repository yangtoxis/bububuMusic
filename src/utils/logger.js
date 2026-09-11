import winston from 'winston';
import { env } from '../config/env.js';

const SECRET_KEY_PATTERN = /token|secret|password/i;

function redact(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = Array.isArray(meta) ? [] : {};
  for (const [key, value] of Object.entries(meta)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = '[REDACTED]';
    } else if (value && typeof value === 'object') {
      out[key] = redact(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const baseLogger = winston.createLogger({
  level: env.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const rest = Object.keys(meta).length ? ` ${JSON.stringify(redact(meta))}` : '';
      return `[${timestamp}] [${level.toUpperCase()}] ${message}${rest}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

export function createLogger(context = {}) {
  return {
    info: (message, meta = {}) => baseLogger.info(message, { ...context, ...meta }),
    warn: (message, meta = {}) => baseLogger.warn(message, { ...context, ...meta }),
    error: (message, meta = {}) => baseLogger.error(message, { ...context, ...meta }),
    debug: (message, meta = {}) => baseLogger.debug(message, { ...context, ...meta }),
  };
}

export const logger = baseLogger;
