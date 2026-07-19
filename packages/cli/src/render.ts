#!/usr/bin/env tsx
/**
 * Stage 5 — Render (legacy file mode).
 * scripts/clips.json + plan meta → output/demo.mp4 via the ffmpeg fast path, falling back
 * to a full Remotion render when overlays/captions/zoom require the composition.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Clip, Keyframe, RenderQuality } from '@wdv/schema';
import { render, renderWithRemotion } from '@wdv/render';
import { cliContext, fail, legacyPaths, loadBrowsePlan, readJson } from './legacy';

const truthy = (v: unknown) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());

async function main() {
  const paths = legacyPaths();
  const plan = loadBrowsePlan(paths);
  const clips = readJson<Clip[]>(paths.clips, []);

  const sourceVideoPath = fs.existsSync(paths.publicMp4) ? paths.publicMp4 : paths.rawMp4;
  const remotionTimeoutMs = Number(process.env.DEMO_REMOTION_TIMEOUT_MS || 120000);

  const envQuality = String(process.env.DEMO_RENDER_QUALITY || plan.meta.renderQuality || 'draft').toLowerCase();
  const quality: RenderQuality = ['draft', 'standard', 'final'].includes(envQuality)
    ? (envQuality as RenderQuality)
    : 'draft';

  // Legacy layout: the composition loads footage via staticFile against public/ (the
  // smoothed 60fps copy is public/raw.mp4).
  const inputProps = {
    videoSrc: 'raw.mp4',
    viewport: plan.viewport,
    clips,
    keyframes: readJson<Keyframe[]>(paths.keyframes, []),
    meta: plan.meta,
  };
  const publicDir = path.join(paths.root, 'public');

  await render(
    {
      clips,
      meta: plan.meta,
      viewport: plan.viewport,
      sourceVideoPath,
      outputPath: paths.outputMp4,
      mode: (process.env.DEMO_RENDER_MODE as 'auto' | 'fast' | 'full') || 'auto',
      quality,
      fps: Number(process.env.DEMO_RENDER_FPS || 60),
      crf: process.env.DEMO_RENDER_CRF || undefined,
      preset: process.env.DEMO_RENDER_PRESET || undefined,
      showFfmpegStats: truthy(process.env.DEMO_FFMPEG_STATS),
      renderFullVideo: async () =>
        renderWithRemotion(
          { inputProps, outputPath: paths.outputMp4, publicDir, quality, timeoutMs: remotionTimeoutMs },
          cliContext,
        ),
      renderOverlaySegment: async (targetPath, frameCount) =>
        renderWithRemotion(
          {
            inputProps,
            outputPath: targetPath,
            publicDir,
            quality,
            frameRange: [0, frameCount - 1],
            muted: true,
            timeoutMs: remotionTimeoutMs,
          },
          cliContext,
        ),
    },
    cliContext,
  );
}

main().catch((err) => fail('Render', err));
