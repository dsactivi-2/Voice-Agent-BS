import OpenAI from 'openai';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { CallSession, LLMResponse, Language } from '../types.js';

export interface LLMContext {
  systemPrompt: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

export interface LLMRequestParams {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens: number;
}

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const FALLBACK_RESPONSES: Record<Language, string> = {
  'bs-BA': 'Mozete li ponoviti, molim vas?',
  'sr-RS': 'Mozete li da ponovite, molim vas?',
};

function buildFallbackResponse(language: Language): LLMResponse {
  return {
    reply_text: FALLBACK_RESPONSES[language],
    interest_score: 0.5,
    complexity_score: 0.3,
    phase: 'hook',
  };
}

function createTimeoutPromise(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`LLM timeout after ${ms}ms`)), ms);
  });
}

export async function* streamLLMResponse(
  params: LLMRequestParams,
): AsyncGenerator<string, LLMResponse> {
  const stream = await Promise.race([
    openai.chat.completions.create({
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens,
      response_format: { type: 'json_object' },
      stream: true,
    }),
    createTimeoutPromise(config.LLM_TIMEOUT_MS),
  ]);

  let fullContent = '';

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      fullContent += delta;
      yield delta;
    }
  }

  const parsed = JSON.parse(fullContent) as LLMResponse;
  return parsed;
}

export async function getLLMResponseWithFallback(
  session: CallSession,
  transcript: string,
  context: LLMContext,
): Promise<LLMResponse> {
  const model = session.llmMode === 'full'
    ? config.LLM_FULL_MODEL
    : config.LLM_MINI_MODEL;

  const messages: LLMRequestParams['messages'] = [
    ...context.messages,
    { role: 'user', content: transcript },
  ];

  try {
    const generator = streamLLMResponse({
      model,
      messages,
      maxTokens: 300,
    });

    let result = await generator.next();
    while (!result.done) {
      result = await generator.next();
    }

    return result.value;
  } catch (error) {
    logger.warn(
      { callId: session.callId, error, model },
      'LLM request failed, returning fallback response',
    );
    return buildFallbackResponse(session.language);
  }
}
