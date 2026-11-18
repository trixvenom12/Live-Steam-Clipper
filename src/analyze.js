import { run, ffmpegBin } from './util.js';

/**
 * Chat rate + loudness z-scores -> hype score per second, then peak picking.
 * Pure functions so this can be tested without a stream.
 */

export function buildChatTimeline(chatTimes, durationSeconds) {
  const seconds = Math.max(1, Math.ceil(durationSeconds));
  const counts = new Float64Array(seconds);
  for (const t of chatTimes) {
    if (t >= 0 && t < seconds) counts[Math.floor(t)] += 1;
  }
  return counts;
}

function zScores(values) {
  const n = values.length;
  if (!n) return [];
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let variance = 0;
  for (const v of values) variance += (v - mean) ** 2;
  const sd = Math.sqrt(variance / n);
  return Array.from(values, (v) => (v - mean) / Math.max(sd, 0.35));
}

function rollingSum(values, window) {
  const out = new Float64Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    out[i] = sum / Math.min(window, i + 1);
  }
  return out;
}

function smooth(values, radius) {
  return Array.from(values, (_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      sum += values[j];
      n++;
    }
    return sum / n;
  });
}

/**
 * @param {{chatTimes:number[], loudness:{t:number,db:number}[], duration:number, detect:object}} input
 * @returns {{at:number, score:number, chatZ:number, audioZ:number}[]}
 */
export function findPeaks({ chatTimes = [], loudness = [], visualActivity = [], duration, detect }) {
  if (!(duration > 0)) return [];
  const opts = {
    minScore: 2,
    minMessages: 12,
    ignoreStartSeconds: 0,
    minGapSeconds: 75,
    maxClipsPerHour: 10,
    lookbackSeconds: 12,
    ...detect,
  };
  const seconds = Math.max(1, Math.ceil(duration));
  const chatCounts = buildChatTimeline(chatTimes, seconds);

  // Chat rate over the trailing lookback window, in messages/second.
  const chatRate = rollingSum(chatCounts, opts.lookbackSeconds);
  const chatZ = zScores(chatRate);

  // Loudness: one dB sample per second if missing.
  const audio = new Float64Array(seconds);
  if (loudness.length) {
    const bucketSum = new Float64Array(seconds);
    const bucketN = new Float64Array(seconds);
    for (const { t, db } of loudness) {
      if (!Number.isFinite(db) || db < -70) continue;
      const i = Math.min(seconds - 1, Math.max(0, Math.floor(t)));
      bucketSum[i] += db;
      bucketN[i] += 1;
    }
    let last = -45;
    for (let i = 0; i < seconds; i++) {
      if (bucketN[i]) last = bucketSum[i] / bucketN[i];
      audio[i] = last;
    }
  } else {
    audio.fill(-45);
  }
  const audioZ = zScores(audio);
  // Positive frame-to-frame RMS changes approximate attacks; this is not pitch
  // detection, but it adds transient reactions without pretending to be one.
  const audioDelta = Float64Array.from(audio, (v, i) => i ? Math.max(0, v - audio[i - 1]) : 0);
  const audioDeltaZ = zScores(audioDelta);

  const visual = new Float64Array(seconds);
  for (const { t, motion = 0, scene = 0 } of visualActivity) {
    if (t < 0 || t >= seconds) continue;
    visual[Math.floor(t)] += Math.max(0, motion) + Math.max(0, scene - 10) * 2;
  }
  const visualZ = zScores(visual);

  const hasChat = chatTimes.length > 0;
  const rawScore = chatZ.map((z, i) =>
    hasChat
      ? Math.max(0, z) + 0.5 * Math.max(0, audioZ[i]) + 0.25 * Math.max(0, audioDeltaZ[i]) + 0.5 * Math.max(0, visualZ[i])
      : Math.max(0, audioZ[i]) + 0.25 * Math.max(0, audioDeltaZ[i]) + 0.5 * Math.max(0, visualZ[i])
  );
  // chatZ is already a trailing-window average, so keep this light — a wide
  // window flattens real spikes below the threshold and nothing ever clips.
  const score = smooth(rawScore, 1);

  // Local maxima + a real amount of chat, so a quiet moment never clips.
  const peaks = [];
  for (let i = 0; i < seconds; i++) {
    if (i < opts.ignoreStartSeconds) continue;
    if (score[i] < opts.minScore) continue;
    let isMax = true;
    for (let j = Math.max(0, i - 10); j <= Math.min(seconds - 1, i + 10); j++) {
      if (score[j] > score[i]) { isMax = false; break; }
    }
    if (!isMax) continue;
    const windowStart = Math.max(0, i - opts.lookbackSeconds);
    let msgs = 0;
    for (let j = windowStart; j <= i; j++) msgs += chatCounts[j];
    if (hasChat && msgs < opts.minMessages) continue;
    const chatContrib = hasChat ? Math.max(0, chatZ[i]) : 0;
    const audioContrib = (hasChat ? 0.5 : 1.0) * Math.max(0, audioZ[i]);
    const visualContrib = 0.5 * Math.max(0, visualZ[i]);
    const parts = [];
    if (hasChat) parts.push(`chat ${chatZ[i].toFixed(1)}σ`);
    if (audioZ[i] > 0) parts.push(`audio ${audioZ[i].toFixed(1)}σ`);
    if (visualZ[i] > 0) parts.push(`visual ${visualZ[i].toFixed(1)}σ`);
    peaks.push({
      at: i,
      score: Number(score[i].toFixed(2)),
      chatZ: Number(chatZ[i].toFixed(2)),
      audioZ: Number(audioZ[i].toFixed(2)),
      audioDeltaZ: Number(audioDeltaZ[i].toFixed(2)),
      visualZ: Number(visualZ[i].toFixed(2)),
      chatMessages: msgs,
      components: {
        chat: Number(chatContrib.toFixed(2)),
        audio: Number(audioContrib.toFixed(2)),
        visual: Number(visualContrib.toFixed(2)),
      },
      rationale: `${parts.join(', ')} · ${msgs} msg in ${opts.lookbackSeconds}s`,
    });
  }

  const maxClips = Math.max(1, Math.ceil((duration / 3600) * opts.maxClipsPerHour));
  const chosen = [];
  for (const peak of peaks.sort((a, b) => b.score - a.score)) {
    if (chosen.length >= maxClips) break;
    if (chosen.some((p) => Math.abs(p.at - peak.at) < opts.minGapSeconds)) continue;
    chosen.push(peak);
  }
  return chosen.sort((a, b) => a.at - b.at);
}

/** Transcript-only local signals; semantic/context judgments require an injected model. */
export function scoreTranscript(words = []) {
  const text = words.map((w) => w.text || '').join(' ').trim();
  const count = words.length;
  const selfContained = count >= 8 && /\b(i|we|he|she|they|this|that|because|when)\b/i.test(text) ? 7 : Math.min(6, count / 2);
  const emphasis = words.filter((w) => /[!?]|(wow|what|no|way|bro|insane|clutch| gg|holy)/i.test(w.text || '')).length;
  return { text, wordCount: count, zeroContextScore: Number(selfContained.toFixed(1)), emphasis };
}

/** Normalize optional model output to the timeline contract used by the editor. */
export function normalizeMomentAnalysis(model, { start = 0, end, words = [] } = {}) {
  const fallbackStart = words[0]?.start ?? start;
  const fallbackEnd = words.at(-1)?.end ?? end;
  const climaxStart = Number(model?.climax_start);
  const climaxEnd = Number(model?.climax_end);
  const setupStart = Number(model?.setup_start);
  const hardCutEnd = Number(model?.hard_cut_end);
  return {
    setup_start: Number.isFinite(setupStart) ? setupStart : fallbackStart,
    climax_start: Number.isFinite(climaxStart) ? climaxStart : Math.max(fallbackStart, fallbackEnd - 2),
    climax_end: Number.isFinite(climaxEnd) ? climaxEnd : fallbackEnd,
    hard_cut_end: Number.isFinite(hardCutEnd) ? hardCutEnd : fallbackEnd,
    zeroContextScore: Number.isFinite(Number(model?.zeroContextScore)) ? Number(model.zeroContextScore) : null,
    source: model ? 'model' : 'fallback',
  };
}

/** Per-second RMS dB from a media file (1s windows at 8 kHz). */
export async function extractLoudness(file) {
  const { stdout } = await run(ffmpegBin(), [
    '-hide_banner', '-nostats', '-i', file, '-vn',
    '-af',
    'aresample=8000,asetnsamples=n=8000:p=1,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f', 'null', '-',
  ], { allowFail: true });

  const samples = [];
  let t = 0;
  for (const line of stdout.split('\n')) {
    const time = /pts_time:([\d.]+)/.exec(line);
    if (time) { t = Number(time[1]); continue; }
    const value = /lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf)/.exec(line);
    if (value) {
      const db = value[1] === '-inf' ? -91 : Number(value[1]);
      samples.push({ t, db });
    }
  }
  return samples;
}

/** One low-resolution motion and scene-change sample per second. */
export async function extractVisualActivity(file) {
  const { stdout } = await run(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', 'fps=1,scale=160:-2:flags=fast_bilinear,tblend=all_mode=difference,signalstats,scdet=threshold=10,metadata=mode=print:key=lavfi.scd.score:file=-,metadata=mode=print:key=lavfi.signalstats.YDIF:file=-',
    '-an', '-f', 'null', '-',
  ], { allowFail: true });

  const samples = new Map();
  let time = 0;
  for (const line of stdout.split('\n')) {
    const frame = /pts_time:([\d.]+)/.exec(line);
    if (frame) time = Number(frame[1]);
    const item = /lavfi\.(?:scd\.score|signalstats\.YDIF)=([\d.]+)/.exec(line);
    if (!item) continue;
    const sample = samples.get(time) || { t: time, motion: 0, scene: 0 };
    if (line.includes('scd.score')) sample.scene = Number(item[1]);
    else sample.motion = Number(item[1]);
    samples.set(time, sample);
  }
  return [...samples.values()].sort((a, b) => a.t - b.t);
}
