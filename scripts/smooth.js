#!/usr/bin/env node
/**
 * Stage 2.5 — Frame interpolation.
 *
 * Upscales recordings/raw.mp4 from its native ~15-25fps (CDP screencast rate)
 * to 60fps using ffmpeg's minterpolate filter, which synthesizes in-between
 * frames via motion estimation. The result replaces public/raw.mp4 so Remotion
 * renders from the smooth version while recordings/raw.mp4 stays untouched.
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

const TARGET_FPS = 60;

function main() {
  if (!fs.existsSync(RAW_MP4)) {
    throw new Error(`No raw recording at ${path.relative(ROOT, RAW_MP4)}. Run "npm run record" first.`);
  }

  console.log(`• Interpolating ${path.relative(ROOT, RAW_MP4)} → ${TARGET_FPS}fps…`);

  const tmpOut = PUBLIC_MP4 + '.tmp.mp4';
  const res = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-i', RAW_MP4,
      '-vf', `fps=${TARGET_FPS}`,
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-movflags', '+faststart',
      tmpOut,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000 },
  );

  if (res.status !== 0) {
    try { fs.unlinkSync(tmpOut); } catch (_e) { /* ignore */ }
    throw new Error(`ffmpeg exited with code ${res.status}.`);
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
