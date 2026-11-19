import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, ffmpegBin, ensureDir, probeDuration, assertMedia, clock } from './util.js';
import { transcribe } from './transcribe.js';
import { buildAss, presetCaptions } from './captions.js';
import { makeHook, makeEditPlan } from './hook.js';
import { evaluateClipQuality } from './qa.js';
import { detectInset, detectFaceCenter } from './vision.js';
import { detectBurnedSubtitles } from './burned.js';
import { scoreTranscript } from './analyze.js';
import { findSceneCuts, snapToNearestSceneCut } from './scene.js';

const FONT_DIR = '/System/Library/Fonts/Supplemental';
const RATIO_DIMS = {
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
  '3:4': { w: 1080, h: 1440 },
};

function workDir(id) {
  // No spaces in the path: ffmpeg filter options hate them.
  const dir = path.join(os.tmpdir(), `gta-clip-${id}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return ensureDir(dir);
}

function assEscape(p) {
  return p.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

/** Input args for one file, or a concat list of live segments. */
export function sourceArgs(source, start, duration) {
  if (source.kind === 'file') {
    return { args: ['-ss', String(start), '-t', String(duration), '-i', source.file], listFile: null };
  }
  const segments = source.segments;
  if (!segments?.length) throw new Error('Clip has no source segments');
  const listFile = path.join(
    ensureDir(path.join(os.tmpdir(), 'gta-clip-lists')),
    `${source.id || 'clip'}-${Math.round(start * 1000)}.txt`,
  );
  fs.writeFileSync(listFile, segments.map((s) => `file '${path.resolve(s.file).replace(/'/g, "'\\''")}'`).join('\n'));
  return {
    args: ['-f', 'concat', '-safe', '0', '-ss', String(start), '-t', String(duration), '-i', listFile],
    listFile,
  };
}

/** Where in the concatenated source timeline a clip starts. */
export function sourceOffset(source, clipStartSeconds) {
  if (source.kind === 'file') return clipStartSeconds;
  const base = Math.min(...source.segments.map((s) => s.startMs)) / 1000;
  return Math.max(0, clipStartSeconds - base);
}

/**
 * Trim the padded window to a natural sentence boundary where speech starts and stops,
 * and rebase word timings onto the new zero.
 */
export function snapToSpeech({ paddedStart, paddedEnd, transcript, minLength = 15, maxLength = 30, preRoll = 4.0 }) {
  const words = transcript.words || [];
  if (!words.length) return { start: paddedStart, end: paddedEnd, words };

  // Look for a clean sentence boundary before the event
  let startIdx = 0;
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const curr = words[i];
    const isPunct = /[.!?]$/.test(prev.text);
    const isPause = curr.start - prev.end >= 0.4;
    const isCapital = /^[A-Z]/.test(curr.text) && (isPause || curr.start - prev.end >= 0.25);
    if ((isPunct || isPause || isCapital) && curr.start <= preRoll + 1.0) {
      startIdx = i;
    }
  }

  const startWord = words[startIdx];
  let start = startWord.start > 0.7 ? paddedStart + Math.max(0, startWord.start - 0.2) : paddedStart;

  // Look for a clean sentence boundary ending between minLength and maxLength
  let endIdx = words.length - 1;
  for (let j = startIdx + 1; j < words.length; j++) {
    const w = words[j];
    const dur = (paddedStart + w.end + 0.3) - start;
    if (dur >= minLength && dur <= maxLength) {
      if (/[.!?]$/.test(w.text) || (words[j + 1] && words[j + 1].start - w.end >= 0.4)) {
        endIdx = j;
        break;
      }
    } else if (dur > maxLength) {
      break;
    }
  }

  const endWord = words[endIdx];
  let end = Math.min(paddedEnd, paddedStart + endWord.end + 0.45);
  if (end - start < minLength) end = Math.min(paddedEnd + 2, start + minLength);
  if (end - start > maxLength) end = start + maxLength;
  if (end <= start) return { start: paddedStart, end: paddedEnd, words };

  const shifted = words
    .filter((w, idx) => idx >= startIdx && idx <= endIdx)
    .map((w) => ({ ...w, start: w.start - (start - paddedStart), end: w.end - (start - paddedStart) }))
    .filter((w) => w.end > 0 && w.start < end - start);
  return { start, end, words: shifted };
}

/**
 * Split the speech-aligned words into kept segments, cutting out long silences
 * (filler/dead air). Never drops short reactions ("NO WAY", screams).
 */
export function keepSegments(words, { gap = 0.65, minSegment = 0.2, pad = 0 } = {}) {
  if (!Array.isArray(words) || words.length < 2) return null;
  const sorted = [...words].filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
    .sort((a, b) => a.start - b.start);
  if (sorted.length < 2) return null;
  const ranges = [];
  let cur = { start: Math.max(0, sorted[0].start - pad), end: sorted[0].end + pad };
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i];
    const wStart = Math.max(0, w.start - pad);
    const wEnd = w.end + pad;
    if (wStart - cur.end > gap) {
      ranges.push(cur);
      cur = { start: wStart, end: wEnd };
    } else {
      cur.end = Math.max(cur.end, wEnd);
    }
  }
  ranges.push(cur);
  const kept = ranges.filter((r) => r.end - r.start >= minSegment);
  if (kept.length <= 1) return null;
  return kept.map((r) => ({ start: Number(r.start.toFixed(3)), end: Number(r.end.toFixed(3)) }));
}

/**
 * Rebase word timings from the original clip timeline onto the stitched
 * timeline produced by keepSegments (gaps removed).
 */
export function remapWords(words, segments) {
  if (!Array.isArray(words) || !Array.isArray(segments) || !segments.length) return words || [];
  let offset = 0;
  const offsets = segments.map((s, i) => {
    const o = offset;
    offset += s.end - s.start;
    return o;
  });
  const out = [];
  for (const w of words) {
    const idx = segments.findIndex((s) => w.start >= s.start - 1e-9 && w.start < s.end + 1e-9);
    if (idx < 0) continue;
    const s = segments[idx];
    out.push({ ...w, start: w.start - s.start + offsets[idx], end: w.end - s.start + offsets[idx] });
  }
  return out;
}

function buildVideoFilter(layout, inset, assFilter, dims = { w: 1080, h: 1920 }, faceCenter = null, inLabel = '0:v') {
  const assPart = assFilter ? `${assFilter},` : '';
  if (inset) {
    const { x, y, w, h } = inset;
    return [
      `[${inLabel}]setpts=PTS-STARTPTS[v0]`,
      '[v0]split=2[a][b]',
      `[a]crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},scale=1080:672:force_original_aspect_ratio=increase,crop=1080:672,eq=saturation=1.12:contrast=1.04[face]`,
      '[b]scale=1080:1248:force_original_aspect_ratio=increase,crop=1080:1248,eq=saturation=1.12:contrast=1.04[game]',
      `[face][game]vstack=inputs=2,${assPart}setpts=PTS-STARTPTS[v]`,
    ].join(';');
  }
  if (layout === 'crop' && faceCenter) {
    // When 16:9 source is scaled to dims.w:dims.h (increase), scaled width is dims.h * (16/9)
    const scaledW = Math.round(dims.h * (16 / 9));
    const maxCropX = Math.max(0, scaledW - dims.w);
    const x = Math.max(0, Math.min(maxCropX, Math.round(faceCenter.cx * scaledW - dims.w / 2)));
    const y = 0;
    return `[${inLabel}]setpts=PTS-STARTPTS,scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h}:${x}:${y},eq=saturation=1.12:contrast=1.04,${assPart}setpts=PTS-STARTPTS[v]`;
  }
  if (layout === 'crop') {
    return `[${inLabel}]setpts=PTS-STARTPTS,scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h},eq=saturation=1.12:contrast=1.04,${assPart}setpts=PTS-STARTPTS[v]`;
  }
  return [
    `[${inLabel}]setpts=PTS-STARTPTS[v0]`,
    '[v0]split=2[base][fg]',
    `[base]scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h},gblur=sigma=28,eq=brightness=-0.12[bg]`,
    `[fg]scale=${dims.w}:-2,eq=saturation=1.12:contrast=1.04[wd]`,
    `[bg][wd]overlay=(W-w)/2:(H-h)/2,${assPart}setpts=PTS-STARTPTS[v]`,
  ].join(';');
}

/**
 * Full clip render: pad -> transcribe -> snap to speech -> reframe -> burn captions.
 */
export async function renderClip(job, config, outDir) {
  const dir = workDir(job.id);
  const minLength = config.clip.minLengthSeconds || 18;
  const maxLength = config.clip.maxLengthSeconds || 45;

  const sourceDuration = job.source.kind === 'file'
    ? await probeDuration(job.source.file)
    : job.source.segments.reduce((n, s) => n + s.durationMs, 0) / 1000;
  const offset = sourceOffset(job.source, job.start);
  if (sourceDuration > 0 && offset >= sourceDuration - 1) {
    throw new Error(`Clip start ${clock(offset)} is past the end of the source (${clock(sourceDuration)})`);
  }

  const base = job.source.kind === 'file' ? 0 : Math.min(...job.source.segments.map((s) => s.startMs)) / 1000;
  const maxAbsEnd = base + sourceDuration;
  // Generous pad: we trim it back to the actual first/last word.
  const paddedStart = Math.max(base, job.start - 1.2);
  const paddedEnd = Math.min(maxAbsEnd || Infinity, job.end + 1.2);
  const paddedArgs = sourceArgs(job.source, sourceOffset(job.source, paddedStart), paddedEnd - paddedStart);

  const audioFile = path.join(dir, 'audio.wav');
  await run(ffmpegBin(), [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...paddedArgs.args,
    '-vn', '-ac', '1', '-ar', '16000', audioFile,
  ]);
  assertMedia(audioFile);

  let transcript = job.transcript || { text: '', words: [] };
  if (!transcript.words?.length) {
    try {
      transcript = await transcribe(audioFile, config);
    } catch (err) {
      // A clip with no captions is better than no clip.
      console.error(`  ! captions skipped: ${err.message.split('\n')[0]}`);
    }
  }

  const snapped = snapToSpeech({
    paddedStart,
    paddedEnd,
    transcript,
    minLength,
    maxLength,
  });
  const transcriptScore = scoreTranscript(snapped.words);
  const zeroContextScore = job.moment?.zeroContextScore ?? transcriptScore.zeroContextScore;
  const quality = evaluateClipQuality({
    words: snapped.words,
    duration: snapped.end - snapped.start,
    zeroContextScore,
  });
  if (config.qa?.strict && !quality.passed) throw new Error(`Clip failed editorial QA: ${quality.failures.join(', ')}`);
  const duration = snapped.end - snapped.start;
  if (!(duration > 0.5)) throw new Error(`Bad clip range: ${job.start}-${job.end}`);

  const finalArgs = sourceArgs(job.source, sourceOffset(job.source, snapped.start), duration);

  const detectFile = job.source.kind === 'file' ? job.source.file : job.source.segments?.[0]?.file;
  let burned = { hasBurned: false, band: null };
  if (detectFile) {
    try { burned = await detectBurnedSubtitles(detectFile, sourceDuration); } catch {}
  }
  const ratio = config.clip?.ratio || '9:16';
  const dims = RATIO_DIMS[ratio] || RATIO_DIMS['9:16'];
  let inset = null;
  let layout = config.clip.layout || 'auto';
  if (burned.hasBurned && layout === 'auto') layout = 'blur';
  if (ratio !== '9:16' && layout === 'auto') layout = 'blur';
  if (ratio !== '9:16') { /* inset stays null */ }
  if (layout !== 'crop' && layout !== 'blur' && ratio === '9:16') {
    inset = config.clip.camRect || (await detectInset(finalArgs.args, duration));
  }
  let faceCenter = null;
  if (layout === 'crop') {
    try { faceCenter = await detectFaceCenter(finalArgs.args, duration); } catch {}
  }

  const attribution = job.channel ? `@${job.channel}${job.platform ? ` (${job.platform.toUpperCase()})` : ''}` : undefined;
  const hookHeader = (config.clip?.headerBanner !== false && transcript.text)
    ? makeHook(transcript.text, 7)
    : undefined;
  const captions = presetCaptions({
    ...config.captions,
    playResX: dims.w,
    playResY: dims.h,
    attribution,
    header: hookHeader,
  });
  if (inset && !config.captions?.marginV) captions.marginV = 740;
  else if (inset && (captions.marginV === 900 || captions.marginV === 360)) captions.marginV = 740;

  const fontDir = fs.existsSync(FONT_DIR) ? FONT_DIR : undefined;
  const assFilterFor = (assPath) => `ass=filename='${assEscape(assPath)}'${fontDir ? `:fontsdir='${assEscape(fontDir)}'` : ''}`;

  const stdEncode = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];

  ensureDir(outDir);
  const file = path.join(outDir, `${job.id}.mp4`);
  const baseFile = path.join(dir, 'base.mp4');

  const smartEnabled = config.clip?.smartTrim !== false;
  const smartSegments = smartEnabled
    ? keepSegments(snapped.words, { gap: config.clip?.trimSilenceGap ?? 0.65, minSegment: 0.2, pad: 0.08 })
    : null;

  let didSmart = false;
  let renderedDuration = duration;
  let renderedWords = snapped.words;
  let renderedStart = snapped.start;
  let renderedEnd = snapped.end;

  if (smartSegments && smartSegments.length > 1) {
    try {
      const targetDuration = Math.min(maxLength, smartSegments.reduce((n, s) => n + (s.end - s.start), 0));
      const vFilters = [];
      const aFilters = [];
      const concatIn = [];
      for (let i = 0; i < smartSegments.length; i++) {
        const seg = smartSegments[i];
        vFilters.push(`[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[vseg${i}]`);
        aFilters.push(`[0:a]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[aseg${i}]`);
        concatIn.push(`[vseg${i}][aseg${i}]`);
      }
      const concatFilter = `${concatIn.join('')}concat=n=${smartSegments.length}:v=1:a=1[vcat][acat]`;
      const layoutFilter = buildVideoFilter(layout, inset, null, dims, faceCenter, 'vcat');
      const aFilter = `[acat]asetpts=PTS-STARTPTS,highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=15:release=150,loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=out:st=${Math.max(0, targetDuration - 0.2).toFixed(2)}:d=0.2[a]`;
      const fullFilter = [...vFilters, ...aFilters, concatFilter, layoutFilter, aFilter].join(';');

      await run(ffmpegBin(), [
        '-y', '-hide_banner', '-loglevel', 'error',
        ...finalArgs.args,
        '-filter_complex', fullFilter,
        '-map', '[v]', '-map', '[a]',
        ...stdEncode,
        '-t', String(targetDuration),
        baseFile,
      ]);
      assertMedia(baseFile);
      renderedDuration = targetDuration;
      renderedStart = snapped.start + smartSegments[0].start;
      renderedEnd = snapped.start + smartSegments[smartSegments.length - 1].end;
      didSmart = true;
    } catch (err) {
      console.error(`  ! single-pass smart trim failed, falling back: ${String(err.message || err).split('\n')[0]}`);
    }
  }

  if (!didSmart) {
    const filter = buildVideoFilter(layout, inset, null, dims, faceCenter, '0:v');
    const targetDuration = Math.min(maxLength, duration);
    await run(ffmpegBin(), [
      '-y', '-hide_banner', '-loglevel', 'error',
      ...finalArgs.args,
      '-filter_complex', `${filter};[0:a]asetpts=PTS-STARTPTS,highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=15:release=150,loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=out:st=${Math.max(0, targetDuration - 0.2).toFixed(2)}:d=0.2[a]`,
      '-map', '[v]', '-map', '[a]',
      ...stdEncode,
      '-t', String(targetDuration),
      baseFile,
    ]);
    assertMedia(baseFile);
    renderedDuration = targetDuration;
    renderedStart = snapped.start;
    renderedEnd = snapped.end;
  }

  // --- Frame-Accurate Zero-Desync Caption Generation ---
  // Transcribe directly from the rendered base video's audio so timestamps
  // match the actual audio track to the millisecond with 0 PTS drift or seek offset.
  let exactWords = renderedWords;
  try {
    const clipWav = path.join(dir, 'clip.wav');
    await run(ffmpegBin(), [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', baseFile, '-vn', '-ac', '1', '-ar', '16000', clipWav,
    ]);
    assertMedia(clipWav);
    const clipTranscript = await transcribe(clipWav, config);
    if (clipTranscript.words?.length) {
      exactWords = clipTranscript.words;
      renderedWords = exactWords;
      transcript = clipTranscript;
    }
  } catch (tErr) {
    console.error(`  ! exact clip audio transcription fallback: ${tErr.message.split('\n')[0]}`);
  }

  // --- PySceneDetect Visual Cut Analysis ---
  let sceneCuts = [];
  try {
    const sceneInfo = await findSceneCuts(baseFile);
    sceneCuts = sceneInfo.cuts || [];
  } catch {}

  // Burn captions onto the base video
  const assFile = path.join(dir, 'subs.ass');
  fs.writeFileSync(assFile, buildAss(exactWords, captions, renderedDuration));
  const assF = assFilterFor(assFile);

  await run(ffmpegBin(), [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', baseFile,
    '-vf', assF,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    file,
  ]);
  assertMedia(file);

  const thumb = path.join(outDir, `${job.id}.jpg`);
  // Optional BGM mix (ducking or constant bed).
  if (config.clip?.bgmFile && fs.existsSync(config.clip.bgmFile)) {
    const bgmOut = path.join(outDir, `${job.id}.bgm.mp4`);
    const mode = config.clip.bgmMode || 'ducking';
    const vol = Number(config.clip.bgmVolume) || 0.25;
    const filter = mode === 'ducking'
      ? `[1:a][0:a]sidechaincompress=threshold=0.02:ratio=6:attack=5:release=200[ducked];[0:a][ducked]amix=inputs=2:duration=first[a]`
      : `[1:a]volume=${vol}[bgm];[0:a][bgm]amix=inputs=2:duration=first[a]`;
    try {
      await run(ffmpegBin(), [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', file, '-stream_loop', '-1', '-i', config.clip.bgmFile,
        '-filter_complex', filter,
        '-map', '0:v', '-map', '[a]',
        ...stdEncode,
        '-t', String(renderedDuration),
        '-movflags', '+faststart',
        bgmOut,
      ]);
      if (fs.existsSync(bgmOut) && fs.statSync(bgmOut).size > 1024) {
        fs.rmSync(file, { force: true });
        fs.renameSync(bgmOut, file);
      }
    } catch (err) {
      console.error(`  ! bgm mix failed: ${String(err.message || err).split('\\n')[0]}`);
    }
  }

  const thumbW = Math.round(dims.w / 2);
  const titleText = String(job.title || '').slice(0, 40).replace(/'/g, "\\\\'");
  const fontFile = '/System/Library/Fonts/Supplemental/Arial Black.ttf';
  const drawText = (titleText && fs.existsSync(fontFile))
    ? `,drawtext=text='${titleText}':fontfile=${fontFile}:fontsize=${Math.round(dims.w * 0.06)}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=12:x=(w-text_w)/2:y=(h-text_h)/2`
    : '';
  await run(ffmpegBin(), [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', '1', '-i', file, '-frames:v', '1', '-vf', `scale=${thumbW}:-2${drawText}`, '-q:v', '4', thumb,
  ], { allowFail: true });

  for (const f of [paddedArgs.listFile, finalArgs.listFile]) if (f) fs.rmSync(f, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });

  return {
    file,
    thumb,
    transcript: { ...transcript, words: renderedWords },
    duration: renderedDuration,
    start: renderedStart,
    end: renderedEnd,
    hook: makeHook(transcript.text),
    inset,
    burnedSubtitles: burned.hasBurned,
    quality,
    zeroContextScore,
    sceneCuts,
    editPlan: makeEditPlan(job.moment, { coldOpen: config.clip?.coldOpen !== false }),
  };
}
