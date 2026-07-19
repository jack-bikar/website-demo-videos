import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { browsePlanSchema, consoleStageContext, type BrowsePlan, type StageContext } from '@wdv/schema';

/**
 * Legacy file-mode layout: one plan + one take living at fixed repo paths. The screen-demo
 * skill and the preview server depend on these locations, so they stay stable until the
 * studio's project mode fully replaces them.
 */
export interface LegacyPaths {
  root: string;
  browsePlan: string;
  moments: string;
  clips: string;
  keyframes: string;
  recordingsDir: string;
  rawMp4: string;
  publicMp4: string;
  outputMp4: string;
}

export function legacyPaths(root = process.cwd()): LegacyPaths {
  return {
    root,
    browsePlan: path.join(root, 'scripts', 'browse-plan.json'),
    moments: path.join(root, 'scripts', 'moments.json'),
    clips: path.join(root, 'scripts', 'clips.json'),
    keyframes: path.join(root, 'scripts', 'keyframes.json'),
    recordingsDir: path.join(root, 'recordings'),
    rawMp4: path.join(root, 'recordings', 'raw.mp4'),
    publicMp4: path.join(root, 'public', 'raw.mp4'),
    outputMp4: path.join(root, 'output', 'demo.mp4'),
  };
}

/** Load env from .env.local first (this project's convention), then .env as a fallback. */
export function loadEnv(root = process.cwd()): void {
  dotenv.config({ path: path.join(root, '.env.local') });
  dotenv.config({ path: path.join(root, '.env') });
}

export function loadBrowsePlan(paths: LegacyPaths): BrowsePlan {
  if (!fs.existsSync(paths.browsePlan)) {
    throw new Error(
      `No browse plan found at ${path.relative(paths.root, paths.browsePlan)}. ` +
        `Stage 1 must create it first (see the screen-demo skill).`,
    );
  }
  const parsed = browsePlanSchema.safeParse(JSON.parse(fs.readFileSync(paths.browsePlan, 'utf8')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`browse-plan.json failed validation:\n${issues}`);
  }
  return parsed.data;
}

export function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (_e) {
    return fallback;
  }
}

export const cliContext: StageContext = consoleStageContext;

export function fail(stage: string, err: unknown): never {
  console.error(`✗ ${stage} failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
}
