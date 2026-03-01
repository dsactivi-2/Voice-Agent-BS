import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import type { Language } from '../types.js';

/** Maps each supported language to its default Azure Neural voice. */
const DEFAULT_VOICES: Record<Language, string> = {
  'bs-BA': config.TTS_VOICE_BS,
  'sr-RS': config.TTS_VOICE_SR,
};

/**
 * Builds SSML markup for Azure TTS (no prosody, no style — natural voice default).
 *
 * @param text     - The plain text to synthesize
 * @param language - BCP-47 language tag (bs-BA or sr-RS)
 * @param voice    - Azure Neural voice name
 * @returns A complete SSML document string
 */
export function buildSSML(text: string, language: Language, voice: string): string {
  // Escape XML special characters in the text to prevent injection
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  // Replace "Step2Job" with a phonetic alias so the Bosnian/Serbian neural
  // voice reads it intelligibly. The <sub> element substitutes the spoken
  // text without affecting the displayed/logged text.
  const brandInjected = escaped
    .replace(/Step2Job-a/gi, '<sub alias="Step Tu Džoba">Step2Job-a</sub>')
    .replace(/Step2Job/gi, '<sub alias="Step Tu Džob">Step2Job</sub>');

  // Wrap standalone integers (2+ digits) so Azure reads them as cardinal
  // numbers ("dvije hiljade osam stotina") rather than individual digits
  // ("dva-osam-nula-nula"). Decimals are also handled (e.g. "3.5").
  const withNumbers = brandInjected.replace(
    /\b(\d{2,}(?:[.,]\d+)?)\b/g,
    '<say-as interpret-as="cardinal">$1</say-as>',
  );

  return [
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${language}">`,
    `  <voice name="${voice}">`,
    `    ${withNumbers}`,
    `  </voice>`,
    `</speak>`,
  ].join('\n');
}

/**
 * Synthesizes speech from text using Azure Cognitive Services Speech SDK.
 *
 * Creates a fresh SpeechSynthesizer per call to avoid state leaks across
 * concurrent requests. The output is raw 16 kHz 16-bit mono PCM suitable
 * for direct streaming over telephony channels.
 *
 * @param text     - The plain text to synthesize
 * @param language - Target language (bs-BA or sr-RS)
 * @param voice    - Optional voice override; defaults to the configured voice for the language
 * @returns A Buffer containing raw PCM audio data
 * @throws When Azure SDK fails after all retries are exhausted
 */
export async function synthesizeSpeech(
  text: string,
  language: Language,
  voice?: string,
): Promise<Buffer> {
  const resolvedVoice = voice ?? DEFAULT_VOICES[language];
  const ssml = buildSSML(text, language, resolvedVoice);

  return withRetry(
    () => callAzureTTS(ssml),
    { maxRetries: 1, baseDelayMs: 300, service: 'azure-tts' },
  );
}

/**
 * Performs the actual Azure SDK call, wrapping the callback-based
 * `speakSsmlAsync` API in a promise.
 */
function callAzureTTS(ssml: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      config.AZURE_SPEECH_KEY,
      config.AZURE_REGION,
    );
    speechConfig.speechSynthesisOutputFormat =
      sdk.SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm;

    // Synthesize to in-memory stream (no audio device output)
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);

    const startMs = Date.now();

    synthesizer.speakSsmlAsync(
      ssml,
      (result: sdk.SpeechSynthesisResult) => {
        const latencyMs = Date.now() - startMs;

        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          const audioBuffer = Buffer.from(result.audioData);
          logger.debug(
            { bytes: audioBuffer.byteLength, latencyMs },
            'Azure TTS synthesis completed',
          );
          synthesizer.close();
          resolve(audioBuffer);
        } else {
          logger.error(
            { reason: result.reason, latencyMs },
            'Azure TTS synthesis failed',
          );
          synthesizer.close();
          reject(new Error(`Synthesis failed: reason=${result.reason}`));
        }
      },
      (error: string) => {
        logger.error({ error }, 'Azure TTS SDK error');
        synthesizer.close();
        reject(new Error(`Azure TTS SDK error: ${error}`));
      },
    );
  });
}
