#!/usr/bin/env tsx
/**
 * Stage 2 — Record (legacy file mode).
 * Drives the browser through scripts/browse-plan.json and captures footage over CDP.
 * Writes recordings/raw.mp4 + scripts/moments.json (+ public/raw.mp4 copy for Remotion).
 */
import fs from 'node:fs';
import path from 'node:path';
import { record, resolveRecordingConfig } from '@wdv/capture';
import { cliContext, fail, legacyPaths, loadBrowsePlan, loadEnv } from './legacy';

async function main() {
  const paths = legacyPaths();
  loadEnv(paths.root);

  const plan = loadBrowsePlan(paths);
  const recording = resolveRecordingConfig(plan);

  const result = await record(
    { plan, recording, outDir: paths.recordingsDir, chromeSearchRoot: paths.root },
    cliContext,
  );

  // Legacy layout: moments live next to the plan; Remotion loads the raw footage via public/.
  fs.mkdirSync(path.dirname(paths.publicMp4), { recursive: true });
  fs.copyFileSync(result.rawVideoPath, paths.publicMp4);
  fs.copyFileSync(result.momentsPath, paths.moments);

  console.log(`  raw video → ${path.relative(paths.root, paths.rawMp4)}`);
  console.log(`  moments   → ${path.relative(paths.root, paths.moments)}`);
  console.log('  Next: npm run trim');
}

main().catch((err) => fail('Recording', err));
