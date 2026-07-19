#!/usr/bin/env tsx
/**
 * Stage 4 — Camera keyframes (legacy file mode).
 * scripts/moments.json (+ plan zoom/viewport) → scripts/keyframes.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Clip, Moment, Viewport } from '@wdv/schema';
import { momentsToKeyframes } from '@wdv/timeline';
import { fail, legacyPaths, readJson } from './legacy';

try {
  const paths = legacyPaths();
  const moments = readJson<Moment[]>(paths.moments, []);
  const clips = readJson<Clip[]>(paths.clips, []);
  const plan = readJson<{ meta?: { zoom?: boolean }; viewport?: Viewport }>(paths.browsePlan, {});

  if (!Array.isArray(moments) || moments.length === 0) {
    fs.writeFileSync(paths.keyframes, JSON.stringify([], null, 2));
    console.log('No moments — wrote empty keyframes.json.');
    process.exit(0);
  }

  if (plan.meta?.zoom === false) {
    fs.writeFileSync(paths.keyframes, JSON.stringify([], null, 2));
    console.log('✓ Camera zoom disabled (meta.zoom: false) — wrote empty keyframes.json.');
    process.exit(0);
  }
  if (!Array.isArray(clips) || clips.length === 0) {
    console.warn('⚠ clips.json is empty — run "npm run trim" first. Generating keyframes from moments anyway.');
  }

  const keyframes = momentsToKeyframes(moments, { zoomEnabled: true, viewport: plan.viewport });

  fs.writeFileSync(paths.keyframes, JSON.stringify(keyframes, null, 2));
  console.log(`✓ Generated ${keyframes.length} keyframes for ${moments.length} actions.`);
  console.log(`  → ${path.relative(paths.root, paths.keyframes)}`);
  console.log('  Next: npm run render');
} catch (err) {
  fail('Keyframes', err);
}
