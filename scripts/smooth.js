#!/usr/bin/env node
/**
 * Stage 2.5 — Frame interpolation.
 *
 * CDP screencast capture is often only ~15-25fps at 1080p. If Remotion renders
 * that directly at 60fps, scroll-heavy footage repeats captured frames and reads
 * as stutter or flicker. This stage keeps recordings/raw.mp4 untouched and writes
 * a motion-interpolated 60fps copy to public/raw.mp4, which Remotion uses.
 *
 * Requires: ffmpeg on PATH.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RAW_MP4 = path.join(ROOT, 'recordings', 'raw.mp4');
const PUBLIC_MP4 = path.join(ROOT, 'public', 'raw.mp4');

const TARGET_FPS = Number(process.env.DEMO_SMOOTH_FPS || 60);
const REQUESTED_MODE = String(process.env.DEMO_SMOOTH_MODE || 'auto').toLowerCase();
const SHOW_FFMPEG_STATS = ['1', 'true', 'yes'].includes(String(process.env.DEMO_FFMPEG_STATS || '').toLowerCase());
const AUTO_MCI_MAX_SECONDS = Number(process.env.DEMO_SMOOTH_MCI_MAX_SECONDS || 12);
const TIMEOUT_MS = Number(process.env.DEMO_SMOOTH_TIMEOUT_MS || 0);

const FILTERS = {
  // Fast option for drafts: blend in-between frames instead of duplicating them.
  blend: `minterpolate=fps=${TARGET_FPS}:mi_mode=blend:scd=fdiff:scd_threshold=12`,
  // Highest-quality option and the default for scroll-heavy demos. Slower, but it avoids the
  // repeated-frame lag that is obvious during long smooth scrolls.
  mci: `minterpolate=fps=${TARGET_FPS}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:me=umh:vsbmc=1:scd=fdiff:scd_threshold=12`,
  // Last-resort constant-FPS conversion. This fixes VFR playback but does not remove judder.
  fps: `fps=${TARGET_FPS}`,
};

function getDurationSeconds(file) {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { encoding: 'utf8' },
  );
  const duration = Number.parseFloat((result.stdout || '').trim());
  return Number.isFinite(duration) ? duration : 0;
}

function isValidVideo(file) {
  if (!fs.existsSync(file)) return false;
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  return result.status === 0;
}

function pickMode(durationSeconds) {
  if (REQUESTED_MODE !== 'auto') return REQUESTED_MODE;
  return durationSeconds > 0 && durationSeconds <= AUTO_MCI_MAX_SECONDS ? 'mci' : 'blend';
}

function runFfmpeg(filter, tmpOut) {
  const logArgs = SHOW_FFMPEG_STATS
    ? ['-hide_banner', '-stats_period', '5']
    : ['-hide_banner', '-nostats', '-loglevel', 'warning'];
  const options = { stdio: ['ignore', 'inherit', 'inherit'] };
  if (Number.isFinite(TIMEOUT_MS) && TIMEOUT_MS > 0) options.timeout = TIMEOUT_MS;

  return spawnSync(
    'ffmpeg',
    [
      ...logArgs,
      '-y',
      '-i', RAW_MP4,
      '-vf', filter,
      '-an',
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '16',
      '-movflags', '+faststart',
      tmpOut,
    ],
    options,
  );
}

function main() {
  if (!fs.existsSync(RAW_MP4)) {
    throw new Error(`No raw recording at ${path.relative(ROOT, RAW_MP4)}. Run "npm run record" first.`);
  }

  if (!Number.isFinite(TARGET_FPS) || TARGET_FPS < 24) {
    throw new Error(`Invalid DEMO_SMOOTH_FPS: ${process.env.DEMO_SMOOTH_FPS}`);
  }

  const durationSeconds = getDurationSeconds(RAW_MP4);
  const mode = pickMode(durationSeconds);
  const filter = FILTERS[mode];
  if (!filter) {
    throw new Error(`Invalid DEMO_SMOOTH_MODE: ${REQUESTED_MODE}. Use auto, mci, blend, or fps.`);
  }

  console.log(
    `• Smoothing ${path.relative(ROOT, RAW_MP4)} → ${path.relative(ROOT, PUBLIC_MP4)} ` +
      `(${TARGET_FPS}fps, ${mode}${REQUESTED_MODE === 'auto' ? ' auto' : ''})…`,
  );

  const tmpOut = PUBLIC_MP4 + '.tmp.mp4';
  const res = runFfmpeg(filter, tmpOut);

  if (res.status !== 0) {
    if (isValidVideo(tmpOut)) {
      console.warn('⚠ ffmpeg exited non-zero after writing a valid MP4; keeping the completed file.');
    } else {
      try { fs.unlinkSync(tmpOut); } catch (_e) { /* ignore */ }
      const detail = res.signal ? `signal ${res.signal}` : `code ${res.status}`;
      throw new Error(`ffmpeg exited with ${detail}.`);
    }
  }

  if (!isValidVideo(tmpOut)) {
    try { fs.unlinkSync(tmpOut); } catch (_e) { /* ignore */ }
    throw new Error('ffmpeg did not produce a valid MP4.');
  }

  fs.renameSync(tmpOut, PUBLIC_MP4);
  const sizeMB = (fs.statSync(PUBLIC_MP4).size / 1048576).toFixed(1);
  console.log(`✓ Smoothed to ${TARGET_FPS}fps → ${path.relative(ROOT, PUBLIC_MP4)} (${sizeMB} MB)`);
}

try {
  main();
} catch (err) {
  console.error('✗ Smoothing failed:', err.message);
  process.exit(1);
}
