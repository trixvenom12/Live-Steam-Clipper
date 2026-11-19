import fs from 'node:fs';
import path from 'node:path';
import { run, ROOT } from './util.js';

const PYTHON_BIN = path.join(ROOT, '.venv', 'bin', 'python');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'detect_scenes.py');

/**
 * Check if PySceneDetect Python environment is available.
 */
export function isSceneDetectAvailable() {
  return fs.existsSync(PYTHON_BIN) && fs.existsSync(SCRIPT_PATH);
}

/**
 * Detect scene cuts using PySceneDetect.
 * @param {string} videoPath - Absolute or relative path to video.
 * @param {object} options - { threshold: 27.0 }
 * @returns {Promise<{ cuts: number[], scenes: Array<{ scene: number, start: number, end: number, duration: number }> }>}
 */
export async function findSceneCuts(videoPath, options = {}) {
  if (!isSceneDetectAvailable()) {
    return { cuts: [], scenes: [], count: 0 };
  }

  const threshold = String(options.threshold || 27.0);
  try {
    const { stdout } = await run(PYTHON_BIN, [SCRIPT_PATH, videoPath, threshold], { allowFail: true });
    // Parse the JSON output from stdout (ignoring any stderr lines)
    const jsonMatch = stdout.trim().match(/\{[\s\S]*\}$/);
    if (!jsonMatch) return { cuts: [], scenes: [], count: 0 };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      cuts: Array.isArray(parsed.cuts) ? parsed.cuts : [],
      scenes: Array.isArray(parsed.scenes) ? parsed.scenes : [],
      count: parsed.count || 0,
    };
  } catch (err) {
    return { cuts: [], scenes: [], count: 0, error: err.message };
  }
}

/**
 * Snap a proposed start/end boundary to the nearest natural camera cut if within tolerance.
 * @param {number} time - Proposed boundary timestamp in seconds.
 * @param {number[]} cuts - Detected scene cut timestamps in seconds.
 * @param {number} maxDelta - Maximum allowed deviation (default 0.75s).
 * @returns {number} Snapped or original timestamp.
 */
export function snapToNearestSceneCut(time, cuts, maxDelta = 0.75) {
  if (!Array.isArray(cuts) || !cuts.length) return time;
  let closest = null;
  let minDiff = Infinity;
  for (const cut of cuts) {
    const diff = Math.abs(cut - time);
    if (diff < minDiff && diff <= maxDelta) {
      minDiff = diff;
      closest = cut;
    }
  }
  return closest !== null ? closest : time;
}
