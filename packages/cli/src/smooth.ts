#!/usr/bin/env tsx
/**
 * Stage 2.5 — Frame interpolation (legacy file mode).
 * recordings/raw.mp4 → motion-interpolated 60fps public/raw.mp4 for Remotion.
 */
import { smooth, type SmoothMode } from '@wdv/render';
import { cliContext, fail, legacyPaths, readJson } from './legacy';

const truthy = (v: unknown) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());

try {
  const paths = legacyPaths();
  const plan = readJson<{ meta?: { smoothMode?: SmoothMode } }>(paths.browsePlan, {});
  const mode = String(process.env.DEMO_SMOOTH_MODE || plan.meta?.smoothMode || 'auto').toLowerCase() as SmoothMode;
  smooth(
    {
      inputPath: paths.rawMp4,
      outputPath: paths.publicMp4,
      targetFps: Number(process.env.DEMO_SMOOTH_FPS || 60),
      mode,
      autoMciMaxSeconds: Number(process.env.DEMO_SMOOTH_MCI_MAX_SECONDS || 12),
      timeoutMs: Number(process.env.DEMO_SMOOTH_TIMEOUT_MS || 0),
      showFfmpegStats: truthy(process.env.DEMO_FFMPEG_STATS),
    },
    cliContext,
  );
} catch (err) {
  fail('Smoothing', err);
}
