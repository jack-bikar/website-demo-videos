#!/usr/bin/env tsx
/**
 * Stage 2.5 — Frame interpolation (legacy file mode).
 * recordings/raw.mp4 → motion-interpolated 60fps public/raw.mp4 for Remotion.
 */
import { smooth, type SmoothMode } from '@wdv/render';
import { cliContext, fail, legacyPaths } from './legacy';

const truthy = (v: unknown) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());

try {
  const paths = legacyPaths();
  smooth(
    {
      inputPath: paths.rawMp4,
      outputPath: paths.publicMp4,
      targetFps: Number(process.env.DEMO_SMOOTH_FPS || 60),
      mode: String(process.env.DEMO_SMOOTH_MODE || 'auto').toLowerCase() as SmoothMode,
      autoMciMaxSeconds: Number(process.env.DEMO_SMOOTH_MCI_MAX_SECONDS || 12),
      timeoutMs: Number(process.env.DEMO_SMOOTH_TIMEOUT_MS || 0),
      showFfmpegStats: truthy(process.env.DEMO_FFMPEG_STATS),
    },
    cliContext,
  );
} catch (err) {
  fail('Smoothing', err);
}
