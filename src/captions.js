/**
 * Word-synced ASS captions: 2-3 words per line, active word highlighted and
 * popped, hype words in a second colour. ASS because ffmpeg burns it with no
 * extra dependency and it keeps per-word timing exact.
 */

const HYPE = /\b(no way|oh my god|omg|insane|crazy|clutch|holy shit|holy|unbelievable|impossible|let'?s go|gg|wtfff?|screaming|destroyed|headshot)\b/i;
const GREEN = /\b(win|won|money|cash|profit|clutch|gg|let'?s go)\b/i;
const RED = /\b(fail|failed|dead|lose|lost|shit|fuck|damn|danger|scam)\b/i;

export function presetCaptions(config = {}) {
  const c = { ...config };
  const preset = c.preset || 'default';
  if (preset === 'one-word') c.wordsPerLine = 1;
  else if (preset === 'karaoke') { c.wordsPerLine = 2; c.kinetic = true; }
  else if (preset === 'highlight') { c.wordsPerLine = 3; c.kinetic = false; }
  return c;
}

export function isHype(text) {
  return HYPE.test(text) || /[!]$/.test(text) || (text.length > 2 && text === text.toUpperCase() && /[A-Z]/.test(text));
}

export function groupWords(words, opts = {}) {
  const { wordsPerLine = 3, maxChars = 16, maxDuration = 3.6, maxGap = 0.85 } = opts;
  const groups = [];
  let current = [];

  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word.text || !Number.isFinite(word.start)) continue;
    const prev = current[current.length - 1];
    const longGap = prev && word.start - prev.end > maxGap;
    const tooLong = prev && (word.end - current[0].start > maxDuration || current.length >= wordsPerLine);
    const tooWide = current.length &&
      current.reduce((n, w) => n + w.text.length + 1, 0) + word.text.length > maxChars;
    if (longGap || tooLong || tooWide) flush();
    current.push(word);
    const nextWord = words[i + 1];
    const hasNextGap = nextWord && nextWord.start - word.end > 0.45;
    if (current.length >= wordsPerLine || (current.length >= 2 && /[.!?…]$/.test(word.text)) || hasNextGap) {
      flush();
    }
  }
  flush();
  return groups;
}

export function assTime(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeText(text) {
  return text.replace(/[\\{}]/g, (c) => `\\${c}`).replace(/\r?\n/g, ' ');
}

export function buildAss(words, config, duration) {
  const c = {
    playResX: 1080,
    playResY: 1920,
    font: 'Arial Black',
    fontSize: 72,
    wordsPerLine: 3,
    uppercase: true,
    highlight: '&H0000E5FF',
    emphasis: '&H0000FF55',
    marginV: 360,
    ...config,
  };
  const groups = groupWords(words, { wordsPerLine: Math.min(3, c.wordsPerLine), maxChars: 16 });

  const creditStyle = c.attribution
    ? `Style: Credit,${c.font},34,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,1,0,1,3,1,7,40,40,65,1\n`
    : '';

  const headerStyle = c.header
    ? `Style: Header,${c.font},42,&H0000FFFF,&H000000FF,&H00000000,&H90000000,-1,0,0,0,100,100,1,0,1,4,2,8,30,30,120,1\n`
    : '';

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${c.playResX}
PlayResY: ${c.playResY}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${c.font},${c.fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,1,0,1,6,3,5,50,50,${Number(c.marginV) || 680},1
${creditStyle}${headerStyle}[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = [];
  if (c.attribution && duration > 0) {
    events.push(`Dialogue: 1,0:00:00.00,${assTime(duration)},Credit,,0,0,0,,{\\c&H00E5E5FF&\\alpha&H20&}🔴 Stream: ${escapeText(c.attribution)}`);
  }
  if (c.header && duration > 0) {
    const headerDur = Math.min(3.5, duration);
    events.push(`Dialogue: 2,0:00:00.00,${assTime(headerDur)},Header,,0,0,0,,{\\fscx112\\fscy112\\t(0,100,\\fscx100\\fscy100)\\c&H0000E5FF&}“${escapeText(c.header.toUpperCase())}”`);
  }
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const nextGroupStart = groups[g + 1]?.[0]?.start ?? duration;
    for (let i = 0; i < group.length; i++) {
      const start = Math.max(0, group[i].start);
      const wordEnd = Math.max(start + 0.12, group[i].end);
      const nextWordStart = group[i + 1]?.start;
      const next = nextWordStart !== undefined
        ? Math.min(nextWordStart, wordEnd + 0.25)
        : Math.min(nextGroupStart, wordEnd + 0.2);
      const end = Math.max(start + 0.08, Math.min(nextGroupStart, next));
      if (start >= duration || end <= start) continue;
      const words = group.map((w, j) => {
        const text = escapeText(c.uppercase ? w.text.toUpperCase() : w.text);
        if (j !== i) return text;
        const hype = isHype(w.text);
        const color = RED.test(w.text) ? '&H003333FF' : GREEN.test(w.text) ? '&H0066FF00' : hype ? c.emphasis : c.highlight;
        if (!c.kinetic) return `{\\c${color}&\\fscx112\\fscy112\\t(0,90,\\fscx100\\fscy100)}${text}{\\c&H00FFFFFF&}`;
        const scale = hype ? 118 : 112;
        const settle = 60;
        return `{\\c${color}&\\fscx${scale}\\fscy${scale}\\t(0,${settle},\\fscx100\\fscy100)}${text}{\\c&H00FFFFFF&}`;
      });
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${words.join(' ')}`);
    }
  }
  return header + events.join('\n') + (events.length ? '\n' : '');
}
