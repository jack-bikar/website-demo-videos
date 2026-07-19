import fs from 'node:fs';
import path from 'node:path';
import type { BrowsePlan, Clip, DemoVideoProps, RenderQuality, StageContext } from '@wdv/schema';
import { record, resolveRecordingConfig, type ResolvedRecording } from '@wdv/capture';
import { getVideoDurationMs, render, renderWithRemotion, smooth, type SmoothMode } from '@wdv/render';
import { momentsToClips, momentsToKeyframes } from '@wdv/timeline';
import type { TakePaths } from './paths';

/**
 * Walkthrough-mode stage functions, orchestrated by the studio job runner (or the stage
 * CLI as a child process). Each writes artifacts into a take directory; DB bookkeeping
 * stays with the caller.
 */

export interface CaptureStageInput {
  plan: BrowsePlan;
  take: TakePaths;
  chromeSearchRoot?: string;
  /** Pre-resolved recording config; defaults to plan + env resolution. */
  recording?: ResolvedRecording;
}

export async function captureStage(input: CaptureStageInput, ctx: StageContext) {
  const recording = input.recording ?? resolveRecordingConfig(input.plan);
  return record(
    { plan: input.plan, recording, outDir: input.take.root, chromeSearchRoot: input.chromeSearchRoot },
    ctx,
  );
}

export interface SmoothStageInput {
  take: TakePaths;
  mode?: SmoothMode;
  targetFps?: number;
}

export async function smoothStage(input: SmoothStageInput, ctx: StageContext) {
  return smooth(
    { inputPath: input.take.rawMp4, outputPath: input.take.smoothMp4, mode: input.mode, targetFps: input.targetFps },
    ctx,
  );
}

export interface DeriveStageInput {
  plan: BrowsePlan;
  take: TakePaths;
}

/** Cheap re-derivation of clips + keyframes from moments.json — no re-capture needed. */
export async function deriveStage(input: DeriveStageInput, ctx: StageContext) {
  const { plan, take } = input;
  const moments = JSON.parse(fs.readFileSync(take.moments, 'utf8'));
  const meta = plan.meta ?? {};
  const num = (v: unknown) => (Number.isFinite(v as number) ? (v as number) : undefined);

  const clips = momentsToClips(
    moments,
    {
      leadMs: num(meta.trimLeadMs),
      tailMs: num(meta.trimTailMs),
      mergeMaxGapMs: num(meta.trimMergeMaxGapMs),
      deadAirGapMs: num(meta.trimDeadAirGapMs),
      preserveStart: meta.preserveStart === true,
    },
    fs.existsSync(take.rawMp4) ? getVideoDurationMs(take.rawMp4) : 0,
  );
  fs.writeFileSync(take.clips, JSON.stringify(clips, null, 2));

  const keyframes = momentsToKeyframes(moments, { zoomEnabled: meta.zoom !== false, viewport: plan.viewport });
  fs.writeFileSync(take.keyframes, JSON.stringify(keyframes, null, 2));

  ctx.log(`✓ Derived ${clips.length} clip(s) and ${keyframes.length} keyframe(s).`);
  return { clips, keyframes };
}

export interface RenderStageInput {
  plan: BrowsePlan;
  take: TakePaths;
  outputPath: string;
  quality: RenderQuality;
  mode: 'auto' | 'fast' | 'full';
  /** Manual cut edits from the studio; null/absent = derived clips.json. */
  clipsOverride?: Clip[] | null;
  timeoutMs?: number;
}

export async function renderStage(input: RenderStageInput, ctx: StageContext) {
  const { plan, take } = input;
  const clips: Clip[] =
    input.clipsOverride ?? (JSON.parse(fs.readFileSync(take.clips, 'utf8')) as Clip[]);
  const keyframes = fs.existsSync(take.keyframes) ? JSON.parse(fs.readFileSync(take.keyframes, 'utf8')) : [];
  const sourceVideoPath = fs.existsSync(take.smoothMp4) ? take.smoothMp4 : take.rawMp4;

  const inputProps: DemoVideoProps = {
    videoSrc: path.basename(sourceVideoPath),
    viewport: plan.viewport,
    clips,
    keyframes,
    meta: plan.meta,
  };
  const timeoutMs = input.timeoutMs ?? 600000;

  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  return render(
    {
      clips,
      meta: plan.meta,
      viewport: plan.viewport,
      sourceVideoPath,
      outputPath: input.outputPath,
      mode: input.mode,
      quality: input.quality,
      renderFullVideo: () =>
        renderWithRemotion(
          { inputProps, outputPath: input.outputPath, publicDir: take.root, quality: input.quality, timeoutMs },
          ctx,
        ),
      renderOverlaySegment: (targetPath, frameCount) =>
        renderWithRemotion(
          {
            inputProps,
            outputPath: targetPath,
            publicDir: take.root,
            quality: input.quality,
            frameRange: [0, frameCount - 1],
            muted: true,
            timeoutMs,
          },
          ctx,
        ),
    },
    ctx,
  );
}
