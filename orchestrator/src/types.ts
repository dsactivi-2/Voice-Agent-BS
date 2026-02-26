export type Language = 'bs-BA' | 'sr-RS';
export type LLMMode = 'mini' | 'full';
export type ABGroup = 'mini_only' | 'mini_to_full' | 'full_only';
export type Phase = 'hook' | 'qualify' | 'pitch' | 'objection' | 'close' | 'confirm';
export type CallResult = 'success' | 'no_answer' | 'rejected' | 'error' | 'timeout';
export type Speaker = 'user' | 'bot';
export type FillerType = 'acknowledge' | 'thinking' | 'affirm';
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface CallSession {
  callId: string;
  phoneNumber: string;
  language: Language;
  llmMode: LLMMode;
  interestScores: number[];
  complexityScore: number;
  phase: Phase;
  campaignId: string;
  abGroup: ABGroup;
  startedAt: Date;
  turnCount: number;
  conversationSummary: string;
  structuredMemory: StructuredMemory;
  callerSpokeRecently: boolean;
}

export interface StructuredMemory {
  customerName?: string;
  currentProvider?: string;
  budgetRange?: string;
  interestedIn?: string[];
  objections: string[];
  tone: 'positive' | 'neutral' | 'skeptical' | 'hostile';
  microCommitment: boolean;
}

export interface LLMResponse {
  reply_text: string;
  interest_score: number;
  complexity_score: number;
  phase: Phase;
}

export interface Turn {
  callId: string;
  turnNumber: number;
  speaker: Speaker;
  text: string;
  interestScore?: number;
  complexityScore?: number;
  llmMode: LLMMode;
  latencyMs?: number;
  timestamp: Date;
}

export interface AgentConfig {
  language: Language;
  telnyxPhoneNumber: string;
  deepgramLanguage: string;
  ttsVoice: string;
  systemPrompt: string;
  fillerLibrary: Record<FillerType, string[]>;
  cachedPhrases: Record<string, string>;
}

export interface HealthCheckResult {
  status: HealthStatus;
  uptime: number;
  checks: {
    postgres: { status: string; latencyMs: number };
    redis: { status: string; latencyMs: number };
    deepgram: { status: string; latencyMs: number };
    azureTts: { status: string; latencyMs: number };
    openai: { status: string; latencyMs: number };
  };
  activeCalls: number;
  version: string;
}

export interface CallMemory {
  phoneNumber: string;
  language: Language;
  campaignId: string;
  conversationSummary: string;
  structuredMemory: StructuredMemory;
  outcome: string;
  sentimentScore: number;
  callCount: number;
  lastCallAt: Date;
}
