#!/usr/bin/env node
/**
 * Stage 3 — Trim dead time.
 *
 * Reads scripts/moments.json and writes scripts/clips.json. Pure Node, no dependencies.
 *
 * Rules (applied exactly as specified):
 *   1. each clip starts 500ms BEFORE its action timestamp
 *   2. each clip ends 1000ms AFTER its action timestamp
 *   3. merge any two adjacent clips that are LESS THAN 2000ms apart
 *   4. where the gap between unrelated actions EXCEEDS 3000ms, do NOT bridge it — keep
 *      them separate (this is what cuts the dead air)
 *   5. repeated same-action moments are treated as an intentional held shot
 *   6. output an array of { start, end, action, type }, times in ms relative to video start
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MOMENTS_IN = path.join(ROOT, 'scripts', 'moments.json');
const CLIPS_OUT = path.join(ROOT, 'scripts', 'clips.json');
const BROWSE_PLAN = path.join(ROOT, 'scripts', 'browse-plan.json');
const RAW_MP4 = path.join(ROOT, 'recordings', 'raw.mp4');

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return fallback;
  }
}

const plan = readJson(BROWSE_PLAN, {});
const meta = (plan && plan.meta) || {};

const LEAD_MS = Number.isFinite(meta.trimLeadMs) ? meta.trimLeadMs : 500; // clip starts this long before the action (rule 1)
const TAIL_MS = Number.isFinite(meta.trimTailMs) ? meta.trimTailMs : 1000; // clip ends this long after the action (rule 2)
const MERGE_MAX_GAP_MS = Number.isFinite(meta.trimMergeMaxGapMs) ? meta.trimMergeMaxGapMs : 2000; // merge clips closer than this (rule 3)
const DEAD_AIR_GAP_MS = Number.isFinite(meta.trimDeadAirGapMs) ? meta.trimDeadAirGapMs : 3000; // never bridge action gaps larger than this (rule 4)
const PRESERVE_START = meta.preserveStart === true;

function getRawDuration() {
  if (!fs.existsSync(RAW_MP4)) return 0;
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', RAW_MP4,
  ], { encoding: 'utf8' });
  const s = parseFloat(r.stdout.trim());
  return Number.isFinite(s) ? Math.round(s * 1000) : 0;
}

function main() {
  if (!fs.existsSync(MOMENTS_IN)) {
    throw new Error(`No moments file at ${path.relative(ROOT, MOMENTS_IN)}. Run "npm run record" first.`);
  }

  const moments = JSON.parse(fs.readFileSync(MOMENTS_IN, 'utf8'));
  const rawDuration = getRawDuration();
  if (!Array.isArray(moments) || moments.length === 0) {
    fs.writeFileSync(CLIPS_OUT, JSON.stringify([], null, 2));
    console.log('No moments to trim — wrote empty clips.json.');
    return;
  }

  // Sort by time so adjacency logic is well-defined.
  const sorted = [...moments].sort((a, b) => a.time - b.time);

  // Rule 1 + 2: turn each action into a raw clip window (clamped at >= 0).
  const raw = sorted.map((m) => ({
    start: Math.max(0, m.time - LEAD_MS),
    end: m.time + TAIL_MS,
    action: m.action,
    type: m.type,
    // optional per-section playback speed carried from the plan (composition honors it)
    speed: m.speed,
    // keep the original action time around for the dead-air check below
    _t: m.time,
    _lastAction: m.action,
    _lastType: m.type,
  }));

  // Rules 3 + 4: walk the clips and decide, for each adjacent pair, whether to merge.
  const clips = [];
  let current = { ...raw[0] };
  if (PRESERVE_START) current.start = 0;

  for (let i = 1; i < raw.length; i++) {
    const next = raw[i];

    // Gap between the two ACTIONS (rule 4 is defined on action spacing, not clip edges).
    const actionGap = next._t - current._t;
    // Gap between this clip's end and the next clip's start (rule 3).
    const clipGap = next.start - current.end;

    const sameAction = (current._lastAction || '') === (next.action || '') && (current._lastType || '') === (next.type || '');
    const tooMuchDeadAir = !sameAction && actionGap > DEAD_AIR_GAP_MS; // rule 4: keep separate
    const closeEnoughToMerge = clipGap < MERGE_MAX_GAP_MS; // rule 3: merge

    if (!tooMuchDeadAir && closeEnoughToMerge) {
      // Merge: extend the current clip to cover the next one.
      current.end = Math.max(current.end, next.end);
      current._t = next._t; // track the latest action for subsequent gap checks
      current._lastAction = next.action;
      current._lastType = next.type;
      // Action label reflects the span; keep the first action's label as the lead-in.
    } else {
      clips.push(current);
      current = { ...next };
    }
  }
  clips.push(current);

  // Strip the internal _t helper before writing; keep `speed` only when one was set (the
  // first action's speed wins for a merged clip, matching its lead-in label).
  const output = clips
    .map(({ start, end, action, type, speed }) => {
      const clampedEnd = rawDuration > 0 ? Math.min(end, rawDuration) : end;
      const clip = { start, end: clampedEnd, action, type };
      if (Number.isFinite(speed)) clip.speed = speed;
      return clip;
    })
    .filter((clip) => clip.end > clip.start);

  const finalMoment = sorted[sorted.length - 1];
  if (finalMoment && finalMoment.type === 'focus' && rawDuration > 0 && output.length > 0) {
    output[output.length - 1].end = rawDuration;
  }

  fs.writeFileSync(CLIPS_OUT, JSON.stringify(output, null, 2));

  const totalKept = output.reduce((sum, c) => sum + (c.end - c.start), 0);
  console.log(
    `✓ Trimmed ${moments.length} moments → ${output.length} clip(s), ` +
      `${(totalKept / 1000).toFixed(1)}s of footage kept.`,
  );
  console.log(`  → ${path.relative(ROOT, CLIPS_OUT)}`);
  console.log('  Next: npm run keyframes');
}

try {
  main();
} catch (err) {
  console.error('✗ Trim failed:', err.message);
  process.exit(1);
}
