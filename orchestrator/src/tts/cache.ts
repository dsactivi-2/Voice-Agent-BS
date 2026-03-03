import { redis } from '../cache/redis-client.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { Language } from '../types.js';

/** Redis key prefix for all TTS audio cache entries. */
const KEY_PREFIX = 'tts:audio:';

/**
 * Standard phrases pre-synthesized at startup, keyed by phrase identifier.
 * Each entry maps to the text spoken for that phrase per language variant.
 */
const STANDARD_PHRASES: Record<string, Record<Language, string>> = {
  // Greeting phrases — phonetic version (avoids <sub> SSML element that causes Azure reason=1)
  // Audio plays identically to the agent's intro phrase; cache key match is what matters
  intro_bs: {
    'bs-BA': 'Dobar dan, Goran ovdje iz Step Tu Džob-a.',
    'sr-RS': 'Dobar dan, Goran ovdje iz Step Tu Džob-a.',
  },
  intro_sr: {
    'bs-BA': 'Dobar dan, Vesna ovdje iz Step Tu Džob-a.',
    'sr-RS': 'Dobar dan, Vesna ovdje iz Step Tu Džob-a.',
  },
  // Repeat phrases — must match agent cachedPhrases.repeat
  repeat_bs: {
    'bs-BA': 'Mozete li ponoviti, molim vas?',
    'sr-RS': 'Mozete li ponoviti, molim vas?',
  },
  repeat_sr: {
    'bs-BA': 'Mozete li da ponovite, molim vas?',
    'sr-RS': 'Mozete li da ponovite, molim vas?',
  },
  // Goodbye phrases — must match agent cachedPhrases.goodbye
  goodbye_bs: {
    'bs-BA': 'Razumijem potpuno. Ako se situacija promijeni, tu smo. Prijatno!',
    'sr-RS': 'Razumijem potpuno. Ako se situacija promijeni, tu smo. Prijatno!',
  },
  goodbye_sr: {
    'bs-BA': 'Razumem potpuno. Ako se situacija promeni, tu smo. Prijatno!',
    'sr-RS': 'Razumem potpuno. Ako se situacija promeni, tu smo. Prijatno!',
  },
  // Silence check phrases — must match agent cachedPhrases.still_there
  still_there_bs: {
    'bs-BA': 'Jeste li jos tu?',
    'sr-RS': 'Jeste li jos tu?',
  },
  still_there_sr: {
    'bs-BA': 'Da li ste jos tu?',
    'sr-RS': 'Da li ste jos tu?',
  },
  // Filler phrases — must match agent fillerLibrary options
  filler_acknowledge_bs: {
    'bs-BA': 'Razumijem...',
    'sr-RS': 'Razumijem...',
  },
  filler_acknowledge_sr: {
    'bs-BA': 'Razumem...',
    'sr-RS': 'Razumem...',
  },
  filler_thinking_bs: {
    'bs-BA': 'Samo trenutak...',
    'sr-RS': 'Samo trenutak...',
  },
  filler_thinking_sr: {
    'bs-BA': 'Samo sekund...',
    'sr-RS': 'Samo sekund...',
  },
  filler_affirm_bs: {
    'bs-BA': 'Tako je...',
    'sr-RS': 'Tako je...',
  },
  filler_affirm_sr: {
    'bs-BA': 'Da, naravno.',
    'sr-RS': 'Da, naravno.',
  },
  // Silence follow-up — must match agent cachedPhrases.silence_followup
  silence_followup_bs: {
    'bs-BA': 'Sta mislite?',
    'sr-RS': 'Sta mislite?',
  },
  silence_followup_sr: {
    'bs-BA': 'Sta mislite?',
    'sr-RS': 'Sta mislite?',
  },
  // Bad connection — must match agent cachedPhrases.bad_connection
  bad_connection_bs: {
    'bs-BA': 'Izgleda da imamo lose vezu. Javicu se ponovo. Prijatno!',
    'sr-RS': 'Izgleda da imamo lose vezu. Javicu se ponovo. Prijatno!',
  },
  bad_connection_sr: {
    'bs-BA': 'Izgleda da imamo lose vezu. Javicu se ponovo. Prijatno!',
    'sr-RS': 'Izgleda da imamo lose vezu. Javicu se ponovo. Prijatno!',
  },
};

/**
 * Retrieves a cached TTS audio buffer from Redis.
 *
 * @param key - Cache key (typically a hash of the text + voice parameters)
 * @returns The audio Buffer if found, or null on a cache miss or error
 */
export async function getCachedAudio(key: string): Promise<Buffer | null> {
  const redisKey = `${KEY_PREFIX}${key}`;
  try {
    const data = await redis.getBuffer(redisKey);
    if (data === null) {
      logger.debug({ key }, 'TTS cache miss');
      return null;
    }
    logger.debug({ key, bytes: data.byteLength }, 'TTS cache hit');
    return data;
  } catch (err) {
    logger.error({ err, key }, 'Failed to get TTS audio from cache');
    return null;
  }
}

/**
 * Stores a TTS audio buffer in Redis with an optional TTL.
 *
 * @param key        - Cache key
 * @param audio      - Raw audio buffer to store
 * @param ttlSeconds - Time-to-live in seconds; defaults to config.TTS_CACHE_TTL_SECONDS
 */
export async function setCachedAudio(
  key: string,
  audio: Buffer,
  ttlSeconds: number = config.TTS_CACHE_TTL_SECONDS,
): Promise<void> {
  const redisKey = `${KEY_PREFIX}${key}`;
  try {
    await redis.set(redisKey, audio, 'EX', ttlSeconds);
    logger.debug({ key, bytes: audio.byteLength, ttlSeconds }, 'TTS audio cached');
  } catch (err) {
    logger.error({ err, key }, 'Failed to set TTS audio in cache');
    throw err;
  }
}

/**
 * Synthesise function signature accepted by warmTTSCache.
 * Matches the expected TTS provider interface (text + language → raw PCM buffer).
 */
export type SynthesizeFn = (text: string, language: Language) => Promise<Buffer>;

/**
 * Pre-synthesizes all standard phrases and stores them in Redis at startup.
 * Failures on individual phrases are logged but do not abort the warm-up.
 *
 * @param synthesizeFn - TTS synthesis function to call for each phrase
 */
export async function warmTTSCache(synthesizeFn: SynthesizeFn): Promise<void> {
  logger.info(
    { phraseCount: Object.keys(STANDARD_PHRASES).length },
    'Starting TTS cache warm-up',
  );

  const languages: Language[] = ['bs-BA', 'sr-RS'];

  // Build list of (phraseKey, language, text, cacheKey) tuples, intro first
  const entries: Array<{ phraseKey: string; language: Language; text: string; cacheKey: string }> = [];

  // Ensure intro phrases are synthesized first (critical path for first call)
  const phraseEntries = Object.entries(STANDARD_PHRASES).sort(([a], [b]) =>
    a.startsWith('intro') ? -1 : b.startsWith('intro') ? 1 : 0,
  );

  for (const [phraseKey, languageMap] of phraseEntries) {
    for (const language of languages) {
      entries.push({ phraseKey, language, text: languageMap[language], cacheKey: `${phraseKey}:${language}` });
    }
  }

  // Process in batches of 3 to avoid overwhelming Azure TTS with concurrent connections
  const BATCH_SIZE = 3;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async ({ phraseKey, language, text, cacheKey }) => {
        try {
          const existing = await getCachedAudio(cacheKey);
          if (existing !== null) {
            logger.debug({ phraseKey, language }, 'TTS phrase already cached — skipping');
            return;
          }
          const audio = await synthesizeFn(text, language);
          await setCachedAudio(cacheKey, audio);
          logger.debug({ phraseKey, language, bytes: audio.byteLength }, 'TTS phrase warmed');
        } catch (err) {
          logger.warn({ err, phraseKey, language }, 'Failed to warm TTS phrase — continuing');
        }
      }),
    );
  }

  logger.info('TTS cache warm-up complete');
}

/** Exported for direct access in tests and agent config builders. */
export { STANDARD_PHRASES };
