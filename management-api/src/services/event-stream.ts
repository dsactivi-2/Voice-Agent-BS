import type { ServerResponse } from 'node:http';
import { logger } from '../utils/logger.js';

// ─── Call Event Types (matches orchestrator publisher) ───────────────────────

export interface CallStartedEvent {
  type: 'call.started';
  callId: string;
  phoneNumber: string;
  language: string;
  campaignId: string;
  abGroup: string;
  llmMode: string;
  ts: number;
}

export interface CallTurnCompletedEvent {
  type: 'call.turn_completed';
  callId: string;
  turn: number;
  phase: string;
  ts: number;
}

export interface CallPhaseChangedEvent {
  type: 'call.phase_changed';
  callId: string;
  from: string;
  to: string;
  ts: number;
}

export interface CallLlmSwitchedEvent {
  type: 'call.llm_switched';
  callId: string;
  from: string;
  to: string;
  ts: number;
}

export interface CallEndedEvent {
  type: 'call.ended';
  callId: string;
  result: string;
  ts: number;
}

export type CallEvent =
  | CallStartedEvent
  | CallTurnCompletedEvent
  | CallPhaseChangedEvent
  | CallLlmSwitchedEvent
  | CallEndedEvent;

// ─── SSE Client ───────────────────────────────────────────────────────────────

interface SseClient {
  res: ServerResponse;
  /** If set, only events matching this callId are forwarded. Undefined = all events. */
  callId?: string;
}

// ─── EventStreamManager ───────────────────────────────────────────────────────

/**
 * Manages active SSE connections. Receives call events and broadcasts them
 * to all connected clients, with optional per-callId filtering.
 */
export class EventStreamManager {
  private clients = new Set<SseClient>();

  /**
   * Registers a new SSE client response stream.
   * @param res      - The raw Node ServerResponse to write SSE data to
   * @param callId   - Optional filter: only forward events for this callId
   */
  addClient(res: ServerResponse, callId?: string): void {
    this.clients.add({ res, callId });
    logger.debug({ callId, total: this.clients.size }, 'SSE client added');
  }

  /**
   * Removes a client, called when the client HTTP connection closes.
   */
  removeClient(res: ServerResponse): void {
    for (const client of this.clients) {
      if (client.res === res) {
        this.clients.delete(client);
        break;
      }
    }
    logger.debug({ total: this.clients.size }, 'SSE client removed');
  }

  /**
   * Broadcasts a call event to all matching clients.
   * Clients with no callId filter receive every event.
   * Clients filtered to a specific callId only receive matching events.
   */
  broadcast(event: CallEvent): void {
    const data = JSON.stringify(event);
    const message = `data: ${data}\n\n`;

    for (const client of this.clients) {
      if (client.callId !== undefined && client.callId !== event.callId) {
        continue;
      }

      try {
        client.res.write(message);
      } catch (err) {
        logger.warn({ err }, 'Failed to write to SSE client — removing');
        this.clients.delete(client);
      }
    }
  }

  /** Total number of currently connected SSE clients. */
  get connectionCount(): number {
    return this.clients.size;
  }
}

/** Singleton instance shared across the application. */
export const eventStreamManager = new EventStreamManager();
