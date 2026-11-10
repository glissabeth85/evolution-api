import { Logger } from '@config/logger.config';

// Public default keys shipped in upstream examples/old releases. Never accept them.
const KNOWN_DEFAULT_KEYS = new Set(['BQYHJGJHJ', '429683C4C977415CAAFCCE10F7D57E11', 'change-me', 'changeme']);

/**
 * Refuse to start with a missing or publicly known global API key: it grants admin
 * access to every instance. Generate one with: openssl rand -hex 32
 */
export function assertSecureApiKey(key: string | undefined, logger: Logger): void {
  if (!key || !key.trim()) {
    logger.error('AUTHENTICATION_API_KEY is not set. Refusing to start. Generate one with: openssl rand -hex 32');
    process.exit(1);
  }

  if (KNOWN_DEFAULT_KEYS.has(key.trim())) {
    logger.error(
      'AUTHENTICATION_API_KEY is a public default value. Refusing to start. Generate one with: openssl rand -hex 32',
    );
    process.exit(1);
  }

  if (key.length < 32) {
    logger.warn(
      'AUTHENTICATION_API_KEY is shorter than 32 characters. Use a longer random key (openssl rand -hex 32).',
    );
  }
}
