#!/usr/bin/env tsx
/**
 * Stage 3 — Trim dead time (legacy file mode).
 * scripts/moments.json → scripts/clips.json via @wdv/timeline's momentsToClips.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Moment } from '@wdv/schema';
import { momentsToClips } from '@wdv/timeline';
import { getVideoDurationMs } from '@wdv/render';
import { fail, legacyPaths, readJson } from './legacy';

try {
  const paths = legacyPaths();
  if (!fs.existsSync(paths.moments)) {
    throw new Error(`No moments file at ${path.relative(paths.root, paths.moments)}. Run "npm run record" first.`);
  }

  const moments = JSON.parse(fs.readFileSync(paths.moments, 'utf8')) as Moment[];
  const plan = readJson<{ meta?: Record<string, unknown> }>(paths.browsePlan, {});
  const meta = (plan.meta ?? {}) as Record<string, number | boolean | undefined>;

  if (!Array.isArray(moments) || moments.length === 0) {
    fs.writeFileSync(paths.clips, JSON.stringify([], null, 2));
    console.log('No moments to trim — wrote empty clips.json.');
    process.exit(0);
  }

  const num = (v: unknown) => (Number.isFinite(v as number) ? (v as number) : undefined);
  const output = momentsToClips(
    moments,
    {
      leadMs: num(meta.trimLeadMs),
      tailMs: num(meta.trimTailMs),
      mergeMaxGapMs: num(meta.trimMergeMaxGapMs),
      deadAirGapMs: num(meta.trimDeadAirGapMs),
      preserveStart: meta.preserveStart === true,
    },
    fs.existsSync(paths.rawMp4) ? getVideoDurationMs(paths.rawMp4) : 0,
  );

  fs.writeFileSync(paths.clips, JSON.stringify(output, null, 2));

  const totalKept = output.reduce((sum, c) => sum + (c.end - c.start), 0);
  console.log(
    `✓ Trimmed ${moments.length} moments → ${output.length} clip(s), ${(totalKept / 1000).toFixed(1)}s of footage kept.`,
  );
  console.log(`  → ${path.relative(paths.root, paths.clips)}`);
  console.log('  Next: npm run keyframes');
} catch (err) {
  fail('Trim', err);
}
