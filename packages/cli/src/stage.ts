#!/usr/bin/env tsx
/**
 * Stage runner child process. The studio job runner spawns:
 *   node --import tsx packages/cli/src/stage.ts <type> --input <file.json>
 *
 * Emits NDJSON progress events on stdout ({"type":"progress"|"log"|"result"}); any
 * non-JSON stdout/stderr (ffmpeg, Remotion) is treated by the parent as raw log lines.
 * The child never touches the DB — all bookkeeping stays with the parent.
 */
import fs from 'node:fs';
import type { BrowsePlan, Clip, RenderQuality, StageContext } from '@wdv/schema';
import { captureStage, deriveStage, renderStage, smoothStage, type TakePaths } from '@wdv/engine';
import type { SmoothMode } from '@wdv/render';
import { fail, loadEnv } from './legacy';

interface StageInput {
  plan: BrowsePlan;
  take: TakePaths;
  chromeSearchRoot?: string;
  outputPath?: string;
  quality?: RenderQuality;
  mode?: 'auto' | 'fast' | 'full';
  clipsOverride?: Clip[] | null;
  smoothMode?: SmoothMode;
}

const emit = (obj: Record<string, unknown>) => process.stdout.write(JSON.stringify(obj) + '\n');

const ctx: StageContext = {
  log: (message) => emit({ type: 'log', level: 'info', message }),
  warn: (message) => emit({ type: 'log', level: 'warn', message }),
  onProgress: ({ value, message }) => emit({ type: 'progress', value, message }),
};

function smoothModeFor(input: StageInput): SmoothMode | undefined {
  return input.smoothMode ?? input.plan.meta?.smoothMode;
}

async function main() {
  loadEnv();
  const type = process.argv[2];
  const inputFlag = process.argv.indexOf('--input');
  if (!type || inputFlag < 0) throw new Error('Usage: stage.ts <type> --input <file.json>');
  const input = JSON.parse(fs.readFileSync(process.argv[inputFlag + 1], 'utf8')) as StageInput;

  switch (type) {
    case 'capture': {
      const result = await captureStage(input, ctx);
      emit({ type: 'result', data: { durationMs: result.durationMs, frameCount: result.frameCount, moments: result.moments.length } });
      break;
    }
    case 'smooth': {
      const result = await smoothStage({ take: input.take, mode: smoothModeFor(input) }, ctx);
      emit({ type: 'result', data: { mode: result.mode } });
      break;
    }
    case 'derive': {
      const result = await deriveStage(input, ctx);
      emit({ type: 'result', data: { clips: result.clips.length, keyframes: result.keyframes.length } });
      break;
    }
    case 'render': {
      if (!input.outputPath) throw new Error('render stage requires outputPath');
      const result = await renderStage(
        {
          plan: input.plan,
          take: input.take,
          outputPath: input.outputPath,
          quality: input.quality ?? 'draft',
          mode: input.mode ?? 'auto',
          clipsOverride: input.clipsOverride,
        },
        ctx,
      );
      emit({ type: 'result', data: { outputPath: result.outputPath, mode: result.mode } });
      break;
    }
    case 'pipeline': {
      // capture → parallel [smooth, derive] — mirrors the legacy demo.js orchestration.
      const capture = await captureStage(input, ctx);
      emit({ type: 'progress', value: 0.6, message: 'Captured; post-processing' });
      await Promise.all([smoothStage({ take: input.take, mode: smoothModeFor(input) }, ctx), deriveStage(input, ctx)]);
      emit({ type: 'result', data: { durationMs: capture.durationMs, frameCount: capture.frameCount, moments: capture.moments.length } });
      break;
    }
    default:
      throw new Error(`Unknown stage type: ${type}`);
  }
}

main().catch((err) => fail(`Stage ${process.argv[2]}`, err));
