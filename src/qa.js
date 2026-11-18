import { run, ffmpegBin } from './util.js';

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