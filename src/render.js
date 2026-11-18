import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, ffmpegBin, ensureDir, probeDuration, assertMedia, clock } from './util.js';
import { transcribe } from './transcribe.js';
import { buildAss, presetCaptions } from './captions.js';
import { makeHook } from './hook.js';
import { detectInset, detectFaceCenter } from './vision.js';
import { detectBurnedSubtitles } from './burned.js';

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
 * Trim the padded window to where speech actually starts and stops, and rebase
 * word timings onto the new zero. Silence at the head is the most common reason
 * a clip feels like it started late.
 */
export function snapToSpeech({ paddedStart, paddedEnd, transcript, minLength, maxLength }) {
  const words = transcript.words || [];
  if (!words.length) return { start: paddedStart, end: paddedEnd, words };
  const first = words[0];
  const last = words[words.length - 1];

  let start = first.start > 0.7 ? paddedStart + Math.max(0, first.start - 0.2) : paddedStart;
  let end = Math.min(paddedEnd, paddedStart + last.end + 0.45);
  if (end - start < minLength) end = Math.min(paddedEnd + 2, start + minLength);
  if (end - start > maxLength) end = start + maxLength;
  if (end <= start) return { start: paddedStart, end: paddedEnd, words };

  const shifted = words
    .map((w) => ({ ...w, start: w.start - (start - paddedStart), end: w.end - (start - paddedStart) }))
    .filter((w) => w.end > 0 && w.start < end - start);
  return { start, end, words: shifted };
}

/**
 * Split the speech-aligned words into kept segments, cutting out long silences
 * (filler/dead air). Returns null when nothing would be removed, so the
 * caller can fall back to a single continuous render.
 */
export function keepSegments(words, { gap = 0.45, minSegment = 1.5 } = {}) {
  if (!Array.isArray(words) || words.length < 2) return null;
  const sorted = [...words].filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
    .sort((a, b) => a.start - b.start);
  if (sorted.length < 2) return null;
  const ranges = [];
  let cur = { start: sorted[0].start, end: sorted[0].end };
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i];
    if (w.start - cur.end > gap) {
      ranges.push(cur);
      cur = { start: w.start, end: w.end };
    } else {
      cur.end = Math.max(cur.end, w.end);
    }
  }
  ranges.push(cur);
  const kept = ranges.filter((r) => r.end - r.start >= minSegment);
  if (kept.length <= 1) return null;
  return kept.map((r) => ({ start: r.start, end: r.end }));
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

function buildVideoFilter(layout, inset, assFilter, dims = { w: 1080, h: 1920 }, faceCenter = null) {
  if (inset) {
    const { x, y, w, h } = inset;
    return [
      '[0:v]setpts=PTS-STARTPTS[v0]',
      '[v0]split=2[a][b]',
      '[a]scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080[top]',
      `[b]crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},scale=1080:840:force_original_aspect_ratio=increase,crop=1080:840[bot]`,
      `[top][bot]vstack=inputs=2,${assFilter},setpts=PTS-STARTPTS[v]`,
    ].join(';');
  }
  if (layout === 'crop' && faceCenter) {
    const x = Math.max(0, Math.min(dims.w, Math.round(faceCenter.cx * dims.w - dims.w / 2)));
    const y = Math.max(0, Math.min(dims.h, Math.round(faceCenter.cy * dims.h - dims.h / 2)));
    return `[0:v]setpts=PTS-STARTPTS,scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h}:${x}:${y},${assFilter},setpts=PTS-STARTPTS[v]`;
  }
  if (layout === 'crop') {
    return `[0:v]setpts=PTS-STARTPTS,scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h},${assFilter},setpts=PTS-STARTPTS[v]`;
  }
  return [
    '[0:v]setpts=PTS-STARTPTS[v0]',
    '[v0]split=2[base][fg]',
    `[base]scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h},gblur=sigma=28,eq=brightness=-0.12[bg]`,
    `[fg]scale=${dims.w}:-2[wd]`,
    `[bg][wd]overlay=(W-w)/2:(H-h)/2,${assFilter},setpts=PTS-STARTPTS[v]`,
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
  const paddedStart = Math.max(base, job.start - 2.5);
  const paddedEnd = Math.min(maxAbsEnd || Infinity, job.end + 1.8);
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

  const smartEnabled = config.clip?.smartTrim !== false;
  const smartSegments = smartEnabled
    ? keepSegments(snapped.words, { gap: config.clip?.trimSilenceGap ?? 0.35 })
    : null;

  let didSmart = false;
  let renderedDuration = duration;
  let renderedWords = snapped.words;
  let renderedStart = snapped.start;
  let renderedEnd = snapped.end;

  if (smartSegments && smartSegments.length > 1) {
    try {
      const segTsParts = [];
      for (let i = 0; i < smartSegments.length; i++) {
        const seg = smartSegments[i];
        const segDur = seg.end - seg.start;
        const segWords = snapped.words
          .filter((w) => w.start >= seg.start - 1e-9 && w.start < seg.end + 1e-9)
          .map((w) => ({ ...w, start: w.start - seg.start, end: w.end - seg.start }));
        const segAss = path.join(dir, `seg_${i}.ass`);
        fs.writeFileSync(segAss, buildAss(segWords, captions, segDur));
        const segAssFilter = assFilterFor(segAss);
        const segFilter = buildVideoFilter(layout, inset, segAssFilter, dims, faceCenter);
        const segTs = path.join(dir, `seg_${i}.ts`);
        const segArgs = sourceArgs(job.source, sourceOffset(job.source, snapped.start + seg.start), segDur);
        await run(ffmpegBin(), [
          '-y', '-hide_banner', '-loglevel', 'error',
          ...segArgs.args,
          '-filter_complex', segFilter,
          '-map', '[v]', '-map', '0:a?',
          '-af', 'asetpts=PTS-STARTPTS',
          ...stdEncode,
          '-t', String(segDur),
          '-f', 'mpegts', segTs,
        ]);
        assertMedia(segTs);
        segTsParts.push(segTs);
      }
      const concatTs = path.join(dir, 'smart.ts');
      await run(ffmpegBin(), [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', `concat:${segTsParts.join('|')}`,
        '-c', 'copy', concatTs,
      ]);
      assertMedia(concatTs);
      const targetDuration = Math.min(maxLength, smartSegments.reduce((n, s) => n + (s.end - s.start), 0));
      await run(ffmpegBin(), [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', concatTs,
        '-vf', 'setpts=PTS-STARTPTS',
        '-af', 'asetpts=PTS-STARTPTS,loudnorm=I=-14:TP=-1.5:LRA=11',
        ...stdEncode,
        '-t', String(targetDuration),
        '-movflags', '+faststart',
        file,
      ]);
      assertMedia(file);
      renderedDuration = targetDuration;
      renderedWords = remapWords(snapped.words, smartSegments);
      renderedStart = snapped.start + smartSegments[0].start;
      renderedEnd = snapped.start + smartSegments[smartSegments.length - 1].end;
      didSmart = true;
    } catch (err) {
      console.error(`  ! smart trim failed, falling back: ${String(err.message || err).split('\n')[0]}`);
    }
  }

  if (!didSmart) {
    const assFile = path.join(dir, 'subs.ass');
    fs.writeFileSync(assFile, buildAss(snapped.words, captions, duration));
    const assF = assFilterFor(assFile);
    const filter = buildVideoFilter(layout, inset, assF, dims, faceCenter);
    const targetDuration = Math.min(maxLength, duration);
    await run(ffmpegBin(), [
      '-y', '-hide_banner', '-loglevel', 'error',
      ...finalArgs.args,
      '-filter_complex', filter,
      '-map', '[v]', '-map', '0:a?',
      '-af', 'asetpts=PTS-STARTPTS,loudnorm=I=-14:TP=-1.5:LRA=11',
      ...stdEncode,
      '-t', String(targetDuration),
      '-movflags', '+faststart',
      file,
    ]);
    assertMedia(file);
    renderedDuration = targetDuration;
    renderedWords = snapped.words;
    renderedStart = snapped.start;
    renderedEnd = snapped.end;
  }

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
  };
}
