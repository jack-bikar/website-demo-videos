import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Clip, PlanMeta, RenderQuality, StageContext, Viewport } from '@wdv/schema';
import { resolveOverlay } from '@wdv/schema';
import {
  clampClipsToSource,
  footageSegmentsAfter,
  mergeContinuousClips,
  totalOutputSeconds,
  type FootageSegment,
} from '@wdv/timeline';
import { ffmpegAvailable, getVideoDurationMs } from './probe';

/**
 * ffmpeg fast path ported from scripts/render.js: when the composition adds nothing
 * (no captions/zoom/cards/crop), cut + speed-adjust + concat directly — minutes faster
 * than a full Remotion render. An optional brand-overlay opening is rendered by the
 * injected `renderOverlaySegment` callback (Remotion) and concatenated in front.
 */

export const QUALITY_PRESETS: Record<RenderQuality, { preset: string; crf: number }> = {
  draft: { preset: 'veryfast', crf: 26 },
  standard: { preset: 'medium', crf: 20 },
  final: { preset: 'slow', crf: 16 },
};

export interface RenderRequest {
  clips: Clip[];
  meta: PlanMeta;
  viewport: Viewport;
  sourceVideoPath: string;
  outputPath: string;
  mode: 'auto' | 'fast' | 'full';
  quality: RenderQuality;
  fps?: number;
  /** Explicit x264 overrides (legacy DEMO_RENDER_CRF / DEMO_RENDER_PRESET). */
  crf?: string;
  preset?: string;
  showFfmpegStats?: boolean;
  /** Renders the full composition (all frames) — used when the fast path is blocked. */
  renderFullVideo: () => Promise<void>;
  /** Renders the first `frameCount` composition frames (the brand overlay opening). */
  renderOverlaySegment: (targetPath: string, frameCount: number) => Promise<void>;
}

export interface RenderResult {
  outputPath: string;
  mode: 'fast' | 'full';
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const seconds = (n: number) => Number(n).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';

/** Returns why the fast path can't be used, or null when it can. */
export function fastPathBlocker(request: RenderRequest, clips: Clip[]): string | null {
  const { meta } = request;
  if (!fs.existsSync(request.sourceVideoPath)) {
    return `source video not found at ${request.sourceVideoPath}`;
  }
  if (!clips.length) {
    return 'there are no included clips to render';
  }
  if (meta.captions !== false) {
    return 'captions are enabled';
  }
  if (meta.zoom !== false) {
    return 'zoom/keyframe animation is enabled';
  }
  if (meta.intro || meta.outro || meta.title || meta.subtitle) {
    return 'intro/outro title cards are enabled';
  }
  if (Number(meta.topCropPx || 0) !== 0 || clips.some((clip) => Number(clip.topCropPx || 0) !== 0)) {
    return 'top crop is enabled';
  }
  if (!ffmpegAvailable()) {
    return 'ffmpeg is not available';
  }
  return null;
}

function run(cmd: string, args: string[], label: string, ctx: StageContext, cwd?: string): void {
  ctx.log(`\n${label}`);
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

export async function render(request: RenderRequest, ctx: StageContext): Promise<RenderResult> {
  const quality = QUALITY_PRESETS[request.quality] ?? QUALITY_PRESETS.draft;
  const crf = request.crf ?? String(quality.crf);
  const preset = request.preset ?? quality.preset;
  const fps = request.fps ?? 60;
  const playbackSpeed = Number.isFinite(Number(request.meta.playbackSpeed)) ? Number(request.meta.playbackSpeed) : 4;
  const width = even(request.viewport.width);
  const height = even(request.viewport.height);
  const ffmpegLogArgs = request.showFfmpegStats
    ? ['-hide_banner', '-stats_period', '5']
    : ['-hide_banner', '-nostats', '-loglevel', 'warning'];
  const layoutOpts = { fps, defaultSpeed: playbackSpeed, defaultTopCropPx: Number(request.meta.topCropPx || 0) };
  const tmpRoot = path.join(path.dirname(request.outputPath), `.render-tmp-${process.pid}`);

  ctx.log(`Render quality: ${request.quality} (x264 preset ${preset}, crf ${crf})`);

  if (request.mode === 'full') {
    await request.renderFullVideo();
    return { outputPath: request.outputPath, mode: 'full' };
  }

  let clips = mergeContinuousClips(request.clips, layoutOpts);
  const blocker = fastPathBlocker(request, clips);
  if (blocker) {
    if (request.mode === 'fast') {
      throw new Error(`Fast render cannot be used because ${blocker}.`);
    }
    ctx.log(`Fast render skipped: ${blocker}.`);
    await request.renderFullVideo();
    return { outputPath: request.outputPath, mode: 'full' };
  }

  const sourceDurationMs = getVideoDurationMs(request.sourceVideoPath);
  const maxRequestedEnd = clips.reduce((max, clip) => Math.max(max, clip.end), 0);
  clips = mergeContinuousClips(clampClipsToSource(clips, sourceDurationMs), layoutOpts);
  if (!clips.length) {
    throw new Error('All clips fall outside the available source video.');
  }
  if (sourceDurationMs > 0 && maxRequestedEnd > sourceDurationMs) {
    ctx.log(
      `Clamped clip end from ${seconds(maxRequestedEnd / 1000)}s to source duration ${seconds(sourceDurationMs / 1000)}s.`,
    );
  }

  fs.mkdirSync(path.dirname(request.outputPath), { recursive: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  try {
    const files: string[] = [];
    const totalSeconds = totalOutputSeconds(clips, playbackSpeed);
    const overlay = resolveOverlay(request.meta);
    const overlayFrames = overlay
      ? Math.min(Math.round(overlay.seconds * fps), Math.ceil(totalSeconds * fps))
      : 0;
    const overlaySeconds = overlayFrames / fps;

    if (overlayFrames > 0) {
      const overlayFile = path.join(tmpRoot, 'overlay.mp4');
      await request.renderOverlaySegment(overlayFile, overlayFrames);
      files.push(overlayFile);
    }

    const segments = footageSegmentsAfter(clips, overlaySeconds, layoutOpts);
    const finalHoldSeconds = Number(request.meta.finalHoldSeconds);
    if (segments.length > 0 && Number.isFinite(finalHoldSeconds) && finalHoldSeconds > 0) {
      segments[segments.length - 1].extraHoldSeconds = finalHoldSeconds;
    }
    segments.forEach((segment, index) => {
      const file = path.join(tmpRoot, `segment-${String(index + 1).padStart(2, '0')}.mp4`);
      renderFootageSegment(segment, file, index);
      files.push(file);
    });

    if (!files.length) {
      throw new Error('No renderable segments were produced.');
    }

    concatSegments(files, overlayFrames > 0);
    ctx.log(`\nFast render complete: ${request.outputPath}`);
    return { outputPath: request.outputPath, mode: 'fast' };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  function renderFootageSegment(segment: FootageSegment, target: string, index: number): void {
    const filter = [
      `setpts=(PTS-STARTPTS)/${seconds(segment.speed)}`,
      `fps=${fps}`,
      `trim=end_frame=${segment.outputFrames}`,
      'setpts=PTS-STARTPTS',
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
      'setsar=1',
    ];

    if (Number.isFinite(segment.extraHoldSeconds) && (segment.extraHoldSeconds as number) > 0) {
      filter.push(`tpad=stop_mode=clone:stop_duration=${seconds(segment.extraHoldSeconds as number)}`);
    }

    run(
      'ffmpeg',
      [
        ...ffmpegLogArgs,
        '-y',
        '-ss', seconds(segment.rawStart),
        '-t', seconds(segment.rawDuration),
        '-i', request.sourceVideoPath,
        '-an',
        '-vf', filter.join(','),
        '-c:v', 'libx264',
        '-preset', preset,
        '-crf', crf,
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        target,
      ],
      `Encoding kept footage segment ${index + 1}`,
      ctx,
    );
  }

  function concatSegments(files: string[], hasOverlay: boolean): void {
    if (files.length === 1) {
      fs.copyFileSync(files[0], request.outputPath);
      return;
    }

    if (hasOverlay) {
      const args = [...ffmpegLogArgs, '-y'];
      files.forEach((file) => {
        args.push('-i', file);
      });

      const normalized = files
        .map(
          (_, index) =>
            `[${index}:v]fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[v${index}]`,
        )
        .join(';');
      const inputs = files.map((_, index) => `[v${index}]`).join('');
      args.push(
        '-filter_complex',
        `${normalized};${inputs}concat=n=${files.length}:v=1:a=0,format=yuv420p[v]`,
        '-map', '[v]',
        '-an',
        '-c:v', 'libx264',
        '-preset', preset,
        '-crf', crf,
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        request.outputPath,
      );

      run('ffmpeg', args, 'Joining rendered segments', ctx);
      return;
    }

    const listFile = path.join(tmpRoot, 'concat.txt');
    fs.writeFileSync(listFile, files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));

    run(
      'ffmpeg',
      [
        ...ffmpegLogArgs,
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-an',
        '-c', 'copy',
        '-movflags', '+faststart',
        request.outputPath,
      ],
      'Joining rendered segments',
      ctx,
    );
  }
}
