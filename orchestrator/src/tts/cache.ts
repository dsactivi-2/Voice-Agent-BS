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
  intro_bs: {
    'bs-BA': 'Dobro jutro, ovo je Aktivni pozivni centar. Kako vam mogu pomoći?',
    'sr-RS': 'Dobro jutro, ovo je Aktivni pozivni centar. Kako vam mogu pomoći?',
  },
  intro_sr: {
    'bs-BA': 'Dobar dan, ovde je Aktivni pozivni centar. Čime mogu da vam pomognem?',
    'sr-RS': 'Dobar dan, ovde je Aktivni pozivni centar. Čime mogu da vam pomognem?',
  },
  repeat_bs: {
    'bs-BA': 'Izvините, možete li ponoviti?',
    'sr-RS': 'Izvините, možete li ponoviti?',
  },
  repeat_sr: {
    'bs-BA': 'Izvinite, možete li da ponovite?',
    'sr-RS': 'Izvinite, možete li da ponovite?',
  },
  goodbye_bs: {
    'bs-BA': 'Hvala vam na pozivu. Prijatan dan!',
    'sr-RS': 'Hvala vam na pozivu. Prijatan dan!',
  },
  goodbye_sr: {
    'bs-BA': 'Hvala vam na pozivu. Prijatan dan!',
    'sr-RS': 'Hvala vam na pozivu. Prijatan dan!',
  },
  still_there_bs: {
    'bs-BA': 'Halo, jeste li još uvijek tu?',
    'sr-RS': 'Halo, jeste li još uvijek tu?',
  },
  still_there_sr: {
    'bs-BA': 'Halo, da li ste još tu?',
    'sr-RS': 'Halo, da li ste još tu?',
  },
  filler_acknowledge_bs: {
    'bs-BA': 'Razumijem.',
    'sr-RS': 'Razumijem.',
  },
  filler_acknowledge_sr: {
    'bs-BA': 'Razumem.',
    'sr-RS': 'Razumem.',
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
    'bs-BA': 'Da, naravno.',
    'sr-RS': 'Da, naravno.',
  },
  filler_affirm_sr: {
    'bs-BA': 'Da, naravno.',
    'sr-RS': 'Da, naravno.',
  },
  silence_followup_bs: {
    'bs-BA': 'Jeste li zainteresirani za više informacija?',
    'sr-RS': 'Jeste li zainteresirani za više informacija?',
  },
  silence_followup_sr: {
    'bs-BA': 'Da li ste zainteresovani za više informacija?',
    'sr-RS': 'Da li ste zainteresovani za više informacija?',
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
  const tasks: Array<Promise<void>> = [];

  for (const [phraseKey, languageMap] of Object.entries(STANDARD_PHRASES)) {
    for (const language of languages) {
      const text = languageMap[language];
      const cacheKey = `${phraseKey}:${language}`;

      tasks.push(
        (async () => {
          try {
            // Skip if already cached
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
        })(),
      );
    }
  }

  await Promise.allSettled(tasks);
  logger.info('TTS cache warm-up complete');
}

/** Exported for direct access in tests and agent config builders. */
export { STANDARD_PHRASES };
