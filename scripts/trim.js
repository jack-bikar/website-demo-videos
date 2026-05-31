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
 *   4. where the gap between actions EXCEEDS 3000ms, do NOT bridge it — keep them separate
 *      (this is what cuts the dead air)
 *   5. output an array of { start, end, action, type }, times in ms relative to video start
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MOMENTS_IN = path.join(ROOT, 'scripts', 'moments.json');
const CLIPS_OUT = path.join(ROOT, 'scripts', 'clips.json');

const LEAD_MS = 500; // clip starts this long before the action (rule 1)
const TAIL_MS = 1000; // clip ends this long after the action (rule 2)
const MERGE_MAX_GAP_MS = 2000; // merge clips closer than this (rule 3)
const DEAD_AIR_GAP_MS = 3000; // never bridge action gaps larger than this (rule 4)

function main() {
  if (!fs.existsSync(MOMENTS_IN)) {
    throw new Error(`No moments file at ${path.relative(ROOT, MOMENTS_IN)}. Run "npm run record" first.`);
  }

  const moments = JSON.parse(fs.readFileSync(MOMENTS_IN, 'utf8'));
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
    // keep the original action time around for the dead-air check below
    _t: m.time,
  }));

  // Rules 3 + 4: walk the clips and decide, for each adjacent pair, whether to merge.
  const clips = [];
  let current = { ...raw[0] };

  for (let i = 1; i < raw.length; i++) {
    const next = raw[i];

    // Gap between the two ACTIONS (rule 4 is defined on action spacing, not clip edges).
    const actionGap = next._t - current._t;
    // Gap between this clip's end and the next clip's start (rule 3).
    const clipGap = next.start - current.end;

    const tooMuchDeadAir = actionGap > DEAD_AIR_GAP_MS; // rule 4: keep separate
    const closeEnoughToMerge = clipGap < MERGE_MAX_GAP_MS; // rule 3: merge

    if (!tooMuchDeadAir && closeEnoughToMerge) {
      // Merge: extend the current clip to cover the next one.
      current.end = Math.max(current.end, next.end);
      current._t = next._t; // track the latest action for subsequent gap checks
      // Action label reflects the span; keep the first action's label as the lead-in.
    } else {
      clips.push(current);
      current = { ...next };
    }
  }
  clips.push(current);

  // Strip the internal _t helper before writing.
  const output = clips.map(({ start, end, action, type }) => ({ start, end, action, type }));

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
