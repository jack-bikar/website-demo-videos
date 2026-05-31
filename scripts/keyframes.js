#!/usr/bin/env node
/**
 * Stage 4 — Camera keyframes.
 *
 * Reads scripts/clips.json + scripts/moments.json and writes scripts/keyframes.json.
 * Pure Node, no dependencies.
 *
 * For each action we emit two keyframes that drive a smooth camera move:
 *   - a ZOOM-IN keyframe  (scale 1.3), centered on the action point if coordinates exist,
 *     otherwise screen center, timed ~300ms BEFORE the action.
 *   - a ZOOM-OUT keyframe (scale 1.0) timed ~600ms AFTER the action.
 *
 * Times are in ms relative to video start (same domain as moments.json / clips.json), so
 * the Remotion composition can locate the keyframes that fall inside each clip and play
 * them on that clip's local timeline.
 *
 * Output: array of { time, scale, x, y, action, type } sorted by time.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLIPS_IN = path.join(ROOT, 'scripts', 'clips.json');
const MOMENTS_IN = path.join(ROOT, 'scripts', 'moments.json');
const BROWSE_PLAN = path.join(ROOT, 'scripts', 'browse-plan.json');
const KEYFRAMES_OUT = path.join(ROOT, 'scripts', 'keyframes.json');

const ZOOM_IN_SCALE = 1.3;
const ZOOM_OUT_SCALE = 1.0;
const ZOOM_IN_LEAD_MS = 300; // zoom in this long before the action
const ZOOM_OUT_LAG_MS = 600; // zoom back out this long after the action

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return fallback;
  }
}

function screenCenter() {
  const plan = readJson(BROWSE_PLAN, null);
  const vp = (plan && plan.viewport) || { width: 1280, height: 800 };
  return { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) };
}

function main() {
  const moments = readJson(MOMENTS_IN, []);
  // clips.json isn't strictly required to compute keyframes, but Stage 4 reads it per spec
  // and we use it to confirm the pipeline order was followed.
  const clips = readJson(CLIPS_IN, []);

  if (!Array.isArray(moments) || moments.length === 0) {
    fs.writeFileSync(KEYFRAMES_OUT, JSON.stringify([], null, 2));
    console.log('No moments — wrote empty keyframes.json.');
    return;
  }
  if (!Array.isArray(clips) || clips.length === 0) {
    console.warn('⚠ clips.json is empty — run "npm run trim" first. Generating keyframes from moments anyway.');
  }

  const center = screenCenter();
  const keyframes = [];

  for (const m of moments) {
    const x = Number.isFinite(m.x) ? m.x : center.x;
    const y = Number.isFinite(m.y) ? m.y : center.y;

    keyframes.push({
      time: Math.max(0, m.time - ZOOM_IN_LEAD_MS),
      scale: ZOOM_IN_SCALE,
      x,
      y,
      action: m.action,
      type: m.type,
    });
    keyframes.push({
      time: m.time + ZOOM_OUT_LAG_MS,
      scale: ZOOM_OUT_SCALE,
      x,
      y,
      action: m.action,
      type: m.type,
    });
  }

  keyframes.sort((a, b) => a.time - b.time);

  fs.writeFileSync(KEYFRAMES_OUT, JSON.stringify(keyframes, null, 2));
  console.log(`✓ Generated ${keyframes.length} keyframes for ${moments.length} actions.`);
  console.log(`  → ${path.relative(ROOT, KEYFRAMES_OUT)}`);
  console.log('  Next: npm run render');
}

try {
  main();
} catch (err) {
  console.error('✗ Keyframes failed:', err.message);
  process.exit(1);
}
