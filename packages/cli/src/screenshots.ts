#!/usr/bin/env tsx
/**
 * Screenshot capture for the Screenshot-Based mode.
 * Usage: tsx packages/cli/src/screenshots.ts --url https://example.com [--out dir] [--local]
 * Defaults: url from scripts/browse-plan.json, out = recordings/screenshots-take.
 */
import path from 'node:path';
import { resolveRecordingConfig, screenshots } from '@wdv/capture';
import { cliContext, fail, legacyPaths, loadBrowsePlan, loadEnv } from './legacy';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const paths = legacyPaths();
  loadEnv(paths.root);

  const plan = loadBrowsePlan(paths);
  const url = argValue('--url') ?? plan.url;
  const outDir = path.resolve(argValue('--out') ?? path.join(paths.recordingsDir, 'screenshots-take'));
  const env = process.argv.includes('--local') ? { ...process.env, DEMO_LOCAL: '1' } : process.env;
  const recording = resolveRecordingConfig(plan, env);

  const result = await screenshots(
    { url, recording, outDir, hideText: plan.hideText, chromeSearchRoot: paths.root },
    cliContext,
  );
  cliContext.log(`  manifest → ${result.manifestPath}`);
  cliContext.log(`  brand colors: ${result.pageMeta.brandColors.join(', ') || '(none found)'}`);
}

main().catch((err) => fail('Screenshots', err));
