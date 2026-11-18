import { run, ffmpegBin } from './util.js';

export function evaluateClipQuality({ words = [], duration, zeroContextScore } = {}) {
  const sorted = words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
  const speechSeconds = sorted.reduce((sum, w) => sum + Math.max(0, w.end - w.start), 0);
  const speechRatio = duration > 0 ? Math.min(1, speechSeconds / duration) : 0;
  const deadAirStart = sorted.length ? Math.max(0, sorted[0].start) : duration;
  const failures = [];
  if (speechRatio < 0.45) failures.push('speech ratio below 45%');
  if (deadAirStart > 0.8) failures.push('dead air at start exceeds 0.8s');
  if (Number.isFinite(zeroContextScore) && zeroContextScore < 7) failures.push('zero-context score below 7/10');
  return { speechRatio, deadAirStart, zeroContextScore: zeroContextScore ?? null, failures, passed: failures.length === 0 };
}

export async function technicalFloor(file) {
  const out = { lufs: null, truePeak: null, blackLevel: null, warnings: [] };
  try {
    const { stderr } = await run(ffmpegBin(), [
      '-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-',
    ], { allowFail: true });
    const text = stderr || '';
    const i = /I:\s*(-?[\d.]+)\s*LUFS/.exec(text);
    if (i) out.lufs = Number(i[1]);
    const tp = /Peak:\s*(-?[\d.]+)\s*dBTP/.exec(text) || /true peak:\s*(-?[\d.]+)/i.exec(text);
    if (tp) out.truePeak = Number(tp[1]);
  } catch {}
  try {
    const { stderr } = await run(ffmpegBin(), [
      '-hide_banner', '-nostats', '-i', file, '-vf', 'signalstats', '-an', '-f', 'null', '-',
    ], { allowFail: true });
    const text = stderr || '';
    const y = /YMIN=(\d+)/.exec(text);
    if (y) out.blackLevel = Number(y[1]);
  } catch {}

  if (out.lufs != null && (out.lufs < -16 || out.lufs > -12)) out.warnings.push(`loudness ${out.lufs} LUFS (target -14)`);
  if (out.truePeak != null && out.truePeak > -1) out.warnings.push(`true peak ${out.truePeak} dBTP (clip risk)`);
  if (out.blackLevel != null && out.blackLevel > 10) out.warnings.push(`lifted blacks (YMIN ${out.blackLevel})`);
  return out;
}
