import { isHype } from './captions.js';

/**
 * A one-line hook for the clip card / post caption, picked from the transcript.
 * Deliberately dumb and free: score sentences by hype words and punctuation.
 */
/** Lightweight "hook density" per 1000 transcript words (AutoClip-style). */
export function hookDensity(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const n = words.length || 1;
  const numbers = (String(text).match(/\b\d+(?:[.,]\d+)?\b/g) || []).length;
  const claims = (String(text).match(/\b(is|are|was|were|means|proves|shows|because|therefore|actually|literally|never|always)\b/gi) || []).length;
  const stories = (String(text).match(/\b(I|we|he|she|they|when|after|before|because)\b/gi) || []).length;
  return {
    per1000: Math.round(((numbers + claims + stories) / n) * 1000),
    numbers, claims, stories, words: n,
  };
}

export function makeHook(text, maxWords = 10) {
  const sentences = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 3);
  if (!sentences.length) return '';

  const CURIOSITY = /\b(wait|did you|how did|no way|what did|look at|bro|why would|he really|watch this|they actually|omg|holy)\b/i;

  let best = sentences[0];
  let bestScore = -1;
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    const hype = words.filter(isHype).length;
    const curiosity = CURIOSITY.test(sentence) ? 3 : 0;
    const isQuestionOrExclaim = /[!?]$/.test(sentence) ? 2 : 0;
    const hasNumber = /\b\d+(?:[.,]\d+)?\b/.test(sentence);
    const hasQuote = /"[^"]{3,}"/.test(sentence) || /'[^']{3,}'/.test(sentence);
    const hasProper = words.some((w) => /^[A-Z][a-z]{2,}$/.test(w));
    const selfContained = (hasNumber ? 2 : 0) + (hasQuote ? 2 : 0) + (hasProper ? 1 : 0);
    const score = hype * 3 + curiosity + isQuestionOrExclaim + (sentence.match(/[!?]/g)?.length || 0) * 2 + Math.min(words.length, 12) / 12 + selfContained;
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }

  const words = best.split(/\s+/);
  if (words.length <= maxWords && best.length <= 60) return best.replace(/[.!?]+$/, '');
  return `${words.slice(0, maxWords).join(' ').replace(/[,.!?;:]$/, '')}…`;
}

/** Stable NLE ranges: a short climax cold open followed by the full context. */
export function makeEditPlan(moment = {}, { coldOpen = true } = {}) {
  const start = Number(moment.setup_start);
  const end = Number(moment.hard_cut_end);
  const climaxStart = Number(moment.climax_start);
  const climaxEnd = Number(moment.climax_end);
  if (![start, end].every(Number.isFinite) || end <= start) return [];
  const plan = [];
  if (coldOpen && Number.isFinite(climaxStart) && Number.isFinite(climaxEnd)
      && climaxStart >= start && climaxEnd <= end
      && climaxEnd - climaxStart >= 1.5 && climaxEnd - climaxStart <= 2.5) {
    plan.push({ start: climaxStart, end: climaxEnd, role: 'cold-open' });
  }
  plan.push({ start, end, role: 'body' });
  return plan;
}
