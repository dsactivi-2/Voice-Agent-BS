/**
 * Sentiment & Emotion Detection für Voice Agent
 * Analysiert Transkriptionen auf:
 * - Frustration (negative words, ALL CAPS, multiple exclamation marks)
 * - Interest (questions, positive affirms, engagement markers)
 * - Fatigue (short responses, "hmm", "uh", "ok" only)
 * - Confusion (repeated questions, "what", "explain")
 */

export interface EmotionScores {
  frustration: number;   // 0-1
  interest: number;      // 0-1
  fatigue: number;       // 0-1
  confusion: number;     // 0-1
  engagement: number;    // 0-1 (overall)
}

const FRUSTRATION_KEYWORDS = [
  'ne mogu', 'nema', 'nemam', 'ne trebam', 'preskupo', 'skupo',
  'ne zanima', 'dosadno', 'već', 'prestani', 'otkazi', 'nema smisla',
  'to nije', 'nije moguće', 'ne vredi', 'besmisleno'
];

const INTEREST_KEYWORDS = [
  'interesantno', 'dobro', 'super', 'sviđa', 'možda', 'razmotriti',
  'da', 'sigurno', 'kako', 'kada', 'gdje', 'koliko', 'više info'
];

const FATIGUE_KEYWORDS = [
  'umoran', 'moram ići', 'žurim', 'malo vremena', 'senare'
];

const CONFUSION_KEYWORDS = [
  'šta', 'što', 'kako', 'zašto', 'ponovi', 'objasni', 'ne razumijem'
];

export function detectEmotions(
  transcript: string,
  previousTranscripts: string[] = [],
): EmotionScores {
  const lower = transcript.toLowerCase().trim();
  
  // 1. Frustration Detection
  const frustrationScore = calculateFrustration(lower, transcript);
  
  // 2. Interest Detection
  const interestScore = calculateInterest(lower);
  
  // 3. Fatigue Detection
  const fatigueScore = calculateFatigue(lower, previousTranscripts);
  
  // 4. Confusion Detection
  const confusionScore = calculateConfusion(lower);
  
  // 5. Engagement (inverse of fatigue, weighted average)
  const engagement = (interestScore + (1 - fatigueScore) + (1 - confusionScore)) / 3;
  
  return {
    frustration: Math.min(1, frustrationScore),
    interest: Math.min(1, interestScore),
    fatigue: Math.min(1, fatigueScore),
    confusion: Math.min(1, confusionScore),
    engagement: Math.min(1, engagement),
  };
}

function calculateFrustration(lower: string, original: string): number {
  let score = 0;
  
  // Check keywords
  const frustrationCount = FRUSTRATION_KEYWORDS.filter(k => lower.includes(k)).length;
  score += frustrationCount * 0.15;
  
  // Check ALL CAPS (very rare in bosnian speech, but check for emphasis)
  const capsCount = (original.match(/[A-Z]{3,}/g) || []).length;
  score += Math.min(0.3, capsCount * 0.15);
  
  // Check multiple punctuation marks (!!!!)
  const punctCount = (original.match(/!{2,}/g) || []).length;
  score += Math.min(0.2, punctCount * 0.2);
  
  // Tone: very short response with negative word
  if (lower.length < 5 && FRUSTRATION_KEYWORDS.some(k => lower.includes(k))) {
    score += 0.4;
  }
  
  return score;
}

function calculateInterest(lower: string): number {
  let score = 0;
  
  // Check interest keywords
  const interestCount = INTEREST_KEYWORDS.filter(k => lower.includes(k)).length;
  score += interestCount * 0.2;
  
  // Check for questions (ends with ?)
  if (lower.endsWith('?')) score += 0.3;
  
  // Multiple questions
  const questionCount = (lower.match(/\?/g) || []).length;
  score += Math.min(0.3, questionCount * 0.15);
  
  // Length > 10 words typically shows engagement
  const wordCount = lower.split(/\s+/).length;
  if (wordCount > 10) score += 0.2;
  
  return score;
}

function calculateFatigue(lower: string, previousTranscripts: string[] = []): number {
  let score = 0;
  
  // Check fatigue keywords
  const fatigueCount = FATIGUE_KEYWORDS.filter(k => lower.includes(k)).length;
  score += fatigueCount * 0.3;
  
  // Very short responses (< 3 words)
  const wordCount = lower.split(/\s+/).length;
  if (wordCount <= 2) score += 0.2;
  
  // Repeated single word responses ("ok", "da", "hmm")
  const singleWords = ['ok', 'da', 'hmm', 'hm', 'eh', 'ah'];
  if (singleWords.includes(lower)) score += 0.15;
  
  // Pattern: multiple short responses in a row
  if (previousTranscripts.length > 2) {
    const lastThree = previousTranscripts.slice(-3);
    const allShort = lastThree.every(t => t.split(/\s+/).length <= 2);
    if (allShort) score += 0.3;
  }
  
  return score;
}

function calculateConfusion(lower: string): number {
  let score = 0;
  
  // Check confusion keywords
  const confusionCount = CONFUSION_KEYWORDS.filter(k => lower.includes(k)).length;
  score += confusionCount * 0.25;
  
  // Repeated words (sign of searching for words)
  const words = lower.split(/\s+/);
  const duplicates = words.filter((w, i) => words.indexOf(w) !== i).length;
  score += Math.min(0.2, duplicates * 0.1);
  
  // Multiple question marks
  const questionCount = (lower.match(/\?/g) || []).length;
  if (questionCount > 2) score += 0.15;
  
  return score;
}

/**
 * Generate agent response strategy based on emotions
 */
export function generateResponseStrategy(emotions: EmotionScores): {
  tone: 'empathetic' | 'energetic' | 'calm' | 'detailed';
  pace: 'slow' | 'normal' | 'fast';
  verbosity: 'brief' | 'normal' | 'detailed';
  recommendation: string;
} {
  const { frustration, interest, fatigue, confusion, engagement } = emotions;
  
  let tone: 'empathetic' | 'energetic' | 'calm' | 'detailed' = 'normal' as any;
  let pace: 'slow' | 'normal' | 'fast' = 'normal';
  let verbosity: 'brief' | 'normal' | 'detailed' = 'normal';
  let recommendation = '';
  
  // Frustration → empathetic, slower
  if (frustration > 0.6) {
    tone = 'empathetic';
    pace = 'slow';
    recommendation = 'Acknowledge frustration, offer solutions, ask clarifying questions';
  }
  
  // Confusion → detailed, slower
  else if (confusion > 0.6) {
    tone = 'detailed';
    pace = 'slow';
    verbosity = 'detailed';
    recommendation = 'Break down explanation, provide examples, ask confirmation';
  }
  
  // Fatigue → brief, energetic
  else if (fatigue > 0.6) {
    tone = 'energetic';
    pace = 'fast';
    verbosity = 'brief';
    recommendation = 'Keep it short, energize conversation, suggest callback';
  }
  
  // Low engagement → energetic
  else if (engagement < 0.4) {
    tone = 'energetic';
    recommendation = 'Re-engage with value prop, ask qualifying question';
  }
  
  // High interest → detailed
  else if (interest > 0.6) {
    verbosity = 'detailed';
    recommendation = 'Provide details, build on interest, ask closing question';
  }
  
  return { tone, pace, verbosity, recommendation };
}
