/**
 * Cleans LLM output text before sending to Azure TTS.
 *
 * Azure TTS reads markdown symbols aloud ("asterisk asterisk", "hashtag", etc.)
 * and can stutter on em-dashes, multiple punctuation, or code backticks.
 * This function strips formatting so only natural spoken text reaches TTS.
 *
 * @param text - Raw LLM output token(s)
 * @returns Clean plain text safe for TTS synthesis
 */
export function cleanForTTS(text: string): string {
  return (
    text
      // Remove markdown bold and italic: **text**, *text*, __text__, _text_
      // Order matters: handle double before single to avoid partial matches
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]*)__/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      // Remove markdown headers (#, ##, ###, ...)
      .replace(/^#{1,6}\s+/gm, '')
      // Remove markdown links [label](url) → label
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Remove bare URLs (http/https)
      .replace(/https?:\/\/\S+/g, '')
      // Remove inline code `code` and fenced code blocks ```...```
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`+([^`]*)`+/g, '$1')
      // Replace em-dash — and en-dash – with comma+space for natural pausing
      .replace(/[—–]/g, ', ')
      // Normalise ellipsis: three or more dots → single period
      .replace(/\.{3,}/g, '.')
      // Collapse repeated exclamation/question marks
      .replace(/!{2,}/g, '!')
      .replace(/\?{2,}/g, '?')
      // Remove unordered list markers at line start
      .replace(/^[-*+]\s+/gm, '')
      // Remove ordered list markers at line start
      .replace(/^\d+\.\s+/gm, '')
      // Remove blockquote markers
      .replace(/^>\s*/gm, '')
      // Remove horizontal rules
      .replace(/^[-*_]{3,}\s*$/gm, '')
      // Collapse multiple whitespace / newlines to a single space
      .replace(/\s+/g, ' ')
      .trim()
  );
}
