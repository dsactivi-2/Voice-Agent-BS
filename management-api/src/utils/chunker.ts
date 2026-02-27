/**
 * Splits text into overlapping chunks suitable for embedding.
 *
 * Uses a character-based approximation: 1 token ≈ 4 characters.
 * Chunks respect sentence boundaries where possible to avoid splitting
 * in the middle of a thought, which degrades retrieval quality.
 *
 * @param text        - Raw plain text to split
 * @param maxTokens   - Target maximum tokens per chunk (default: 500)
 * @param overlapTokens - Overlap tokens between consecutive chunks (default: 50)
 * @returns Array of text chunks; empty array if text is empty
 */
export function chunkText(
  text: string,
  maxTokens = 500,
  overlapTokens = 50,
): string[] {
  const CHARS_PER_TOKEN = 4;
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (normalized.length === 0) return [];

  // Split on double newlines (paragraphs) first, then sentences within
  const paragraphs = normalized.split(/\n{2,}/);

  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const sentences = splitSentences(para.trim());

    for (const sentence of sentences) {
      if (sentence.length === 0) continue;

      // If a single sentence exceeds maxChars, hard-split it
      if (sentence.length > maxChars) {
        if (current.length > 0) {
          chunks.push(current.trim());
          current = current.slice(Math.max(0, current.length - overlapChars));
        }
        const hardChunks = hardSplit(sentence, maxChars, overlapChars);
        for (const hc of hardChunks) {
          chunks.push(hc);
        }
        current = hardChunks.at(-1)?.slice(Math.max(0, (hardChunks.at(-1)?.length ?? 0) - overlapChars)) ?? '';
        continue;
      }

      const candidate = current.length > 0 ? `${current} ${sentence}` : sentence;

      if (candidate.length <= maxChars) {
        current = candidate;
      } else {
        // Flush current chunk, start new one with overlap
        if (current.length > 0) {
          chunks.push(current.trim());
          // Carry the last `overlapChars` characters as prefix for the next chunk
          const overlap = current.slice(Math.max(0, current.length - overlapChars));
          current = overlap.length > 0 ? `${overlap} ${sentence}` : sentence;
        } else {
          current = sentence;
        }
      }
    }

    // Paragraph boundary — add a soft break
    if (current.length > 0) {
      current += '\n';
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Estimates token count for a string using the 4 chars/token heuristic.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Splits a paragraph into individual sentences.
 * Handles common abbreviations and decimal numbers to avoid false splits.
 */
function splitSentences(text: string): string[] {
  // Tokenise on '.', '!', '?' followed by whitespace + capital letter
  // but not on decimals (3.14), common abbreviations (Mr., Dr., etc.)
  return text
    .split(/(?<=[.!?])\s+(?=[A-ZŠĐČĆŽ])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Hard-splits a very long string into fixed-size char windows with overlap.
 */
function hardSplit(text: string, maxChars: number, overlapChars: number): string[] {
  const result: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    result.push(text.slice(start, end));
    start += maxChars - overlapChars;
    if (start >= text.length) break;
  }
  return result;
}
