import OpenAI from 'openai';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { Turn, LLMResponse, StructuredMemory } from '../types.js';

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

const SUMMARY_PROMPT =
  'Napiši kratki sažetak razgovora u 2-3 rečenice. Fokus na: interes korisnika, prigovori, ključne činjenice, raspoloženje.';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export class MemoryManager {
  private turns: Turn[] = [];
  private summary: string = '';
  private structured: StructuredMemory = {
    objections: [],
    tone: 'neutral',
    microCommitment: false,
  };
  private turnsSinceLastSummary: number = 0;

  addTurn(turn: Turn): void {
    this.turns.push(turn);
    this.turnsSinceLastSummary++;

    if (this.turnsSinceLastSummary >= config.MEMORY_SUMMARY_INTERVAL_TURNS) {
      this.generateSummaryAsync();
    }
  }

  getSummary(): string {
    return this.summary;
  }

  getStructuredMemory(): StructuredMemory {
    return { ...this.structured };
  }

  buildLLMContext(systemPrompt: string): Message[] {
    const messages: Message[] = [];

    messages.push({ role: 'system', content: systemPrompt });

    if (this.summary) {
      messages.push({
        role: 'system',
        content: `Dosadašnji razgovor: ${this.summary}`,
      });
    }

    const hasStructuredData =
      this.structured.customerName ||
      this.structured.currentProvider ||
      this.structured.budgetRange ||
      (this.structured.interestedIn && this.structured.interestedIn.length > 0) ||
      this.structured.objections.length > 0;

    if (hasStructuredData) {
      messages.push({
        role: 'system',
        content: `Info o korisniku: ${JSON.stringify(this.structured)}`,
      });
    }

    const activeWindow = this.turns.slice(-config.MEMORY_ACTIVE_WINDOW_TURNS);
    for (const turn of activeWindow) {
      messages.push({
        role: turn.speaker === 'user' ? 'user' : 'assistant',
        content: turn.text,
      });
    }

    return messages;
  }

  updateFromLLMResponse(response: LLMResponse, userTranscript: string): void {
    if (response.complexity_score > 0.5) {
      this.structured.tone = 'skeptical';
    }

    if (response.interest_score > 0.7) {
      this.structured.microCommitment = true;
    }

    // Check user's words (not bot reply) for objections to record in memory
    const userLower = userTranscript.toLowerCase();

    const objectionKeywords = [
      'nemam iskustvo',
      'ne znam jezik',
      'previse skupo',
      'moram pricati',
      'ne mogu',
      'nemam vremena',
      'ne zanima me',
      'skupo',
      'ne treba',
      'ne zelim',
    ];

    for (const keyword of objectionKeywords) {
      if (
        userLower.includes(keyword) &&
        !this.structured.objections.includes(keyword)
      ) {
        this.structured.objections.push(keyword);
      }
    }
  }

  reset(): void {
    this.turns = [];
    this.summary = '';
    this.structured = {
      objections: [],
      tone: 'neutral',
      microCommitment: false,
    };
    this.turnsSinceLastSummary = 0;
  }

  private generateSummaryAsync(): void {
    this.turnsSinceLastSummary = 0;

    const conversationText = this.turns
      .map((t) => `${t.speaker}: ${t.text}`)
      .join('\n');

    try {
      const result = openai.chat.completions.create({
        model: config.LLM_MINI_MODEL,
        messages: [
          { role: 'system', content: SUMMARY_PROMPT },
          { role: 'user', content: conversationText },
        ],
        max_tokens: 200,
      });

      Promise.resolve(result)
        .then((completion) => {
          const content = completion.choices[0]?.message?.content;
          if (content) {
            this.summary = content;
            logger.info(
              { turnCount: this.turns.length },
              'Conversation summary updated',
            );
          }
        })
        .catch((error: unknown) => {
          logger.warn({ error }, 'Failed to generate conversation summary');
        });
    } catch (error) {
      logger.warn({ error }, 'Failed to initiate conversation summary generation');
    }
  }
}
