import { describe, it, expect } from 'vitest';
import { chunkText, estimateTokenCount } from '../src/utils/chunker.js';

describe('chunkText', () => {
  it('returns empty array for empty string', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(chunkText('   \n\n   ')).toEqual([]);
  });

  it('returns single chunk for short text', () => {
    const text = 'Kratki tekst koji ne prelazi granicu.';
    const chunks = chunkText(text, 500, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('splits text longer than maxTokens into multiple chunks', () => {
    // 500 tokens * 4 chars/token = 2000 chars — build a 5000 char text
    const sentence = 'Ovo je testna rečenica koja sadrži informacije. '; // ~49 chars
    const text = sentence.repeat(110); // ~5390 chars > 2000 chars (500 tokens)
    const chunks = chunkText(text, 500, 50);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('all chunks fit within maxTokens (chars = maxTokens * 4)', () => {
    const sentence = 'Testna rečenica sa dosta sadržaja za provjeru. ';
    const text = sentence.repeat(200);
    const maxTokens = 300;
    const chunks = chunkText(text, maxTokens, 30);
    const maxChars = maxTokens * 4;
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxChars + 50); // small tolerance for overlap
    }
  });

  it('handles paragraph boundaries', () => {
    const text = 'Prva rečenica.\n\nDruga rečenica.\n\nTreća rečenica.';
    const chunks = chunkText(text, 500, 50);
    expect(chunks.length).toBeGreaterThan(0);
    // All text should be present across chunks
    const combined = chunks.join(' ');
    expect(combined).toContain('Prva rečenica');
    expect(combined).toContain('Druga rečenica');
    expect(combined).toContain('Treća rečenica');
  });

  it('hard-splits a single sentence exceeding maxTokens', () => {
    // A single sentence of 3000 chars (750 tokens) with maxTokens=200
    const longSentence = 'a'.repeat(3000);
    const chunks = chunkText(longSentence, 200, 20);
    const maxChars = 200 * 4; // 800 chars
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it('no chunk is empty', () => {
    const text = 'Jedna. Dvije. Tri. Četiri. Pet.';
    const chunks = chunkText(text, 500, 50);
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('estimateTokenCount', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('returns ceil(length / 4)', () => {
    expect(estimateTokenCount('abcd')).toBe(1);  // 4/4 = 1
    expect(estimateTokenCount('abcde')).toBe(2); // 5/4 = 1.25 → ceil = 2
    expect(estimateTokenCount('a'.repeat(100))).toBe(25); // 100/4 = 25
  });
});
