import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { StageContext } from '@wdv/schema';
import { getDurationSeconds, isValidVideo } from './probe';

/**
 * Frame interpolation. CDP screencast capture is often only ~15-25fps at 1080p; rendering
 * that directly at 60fps repeats frames and reads as stutter. This writes a motion-interpolated
 * copy while leaving the raw recording untouched. Ported from scripts/smooth.js.
 */

export type SmoothMode = 'auto' | 'mci' | 'blend' | 'fps';

export interface SmoothRequest {
  inputPath: string;
  outputPath: string;
  targetFps?: number;
  mode?: SmoothMode;
  /** auto mode uses mci only for footage at most this long (mci is minutes-slow). */
  autoMciMaxSeconds?: number;
  timeoutMs?: number;
  showFfmpegStats?: boolean;
}

const filters = (fps: number): Record<Exclude<SmoothMode, 'auto'>, string> => ({
  // Fast option for drafts: blend in-between frames instead of duplicating them.
  blend: `minterpolate=fps=${fps}:mi_mode=blend:scd=fdiff:scd_threshold=12`,
  // Highest-quality option and the default for scroll-heavy demos. Slower, but it avoids the
  // repeated-frame lag that is obvious during long smooth scrolls.
  mci: `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:me=umh:vsbmc=1:scd=fdiff:scd_threshold=12`,
  // Last-resort constant-FPS conversion. Fixes VFR playback but does not remove judder.
  fps: `fps=${fps}`,
});

export function smooth(request: SmoothRequest, ctx: StageContext): { outputPath: string; mode: string } {
  const { inputPath, outputPath } = request;
  if (!fs.existsSync(inputPath)) {
    throw new Error(`No raw recording at ${inputPath}. Record first.`);
  }

  const targetFps = request.targetFps ?? 60;
  if (!Number.isFinite(targetFps) || targetFps < 24) {
    throw new Error(`Invalid smooth target fps: ${targetFps}`);
  }

  const requestedMode = request.mode ?? 'auto';
  const autoMciMaxSeconds = request.autoMciMaxSeconds ?? 12;
  const durationSeconds = getDurationSeconds(inputPath);
  const mode: Exclude<SmoothMode, 'auto'> =
    requestedMode === 'auto'
      ? durationSeconds > 0 && durationSeconds <= autoMciMaxSeconds
        ? 'mci'
        : 'blend'
      : requestedMode;

  const filter = filters(targetFps)[mode];
  if (!filter) {
    throw new Error(`Invalid smooth mode: ${requestedMode}. Use auto, mci, blend, or fps.`);
  }

  ctx.log(`• Smoothing ${inputPath} → ${outputPath} (${targetFps}fps, ${mode}${requestedMode === 'auto' ? ' auto' : ''})…`);

  const logArgs = request.showFfmpegStats
    ? ['-hide_banner', '-stats_period', '5']
    : ['-hide_banner', '-nostats', '-loglevel', 'warning'];
  const tmpOut = outputPath + '.tmp.mp4';
  const options: Parameters<typeof spawnSync>[2] = { stdio: ['ignore', 'inherit', 'inherit'] };
  if (Number.isFinite(request.timeoutMs) && (request.timeoutMs as number) > 0) options.timeout = request.timeoutMs;

  const res = spawnSync(
    'ffmpeg',
    [
      ...logArgs,
      '-y',
      '-i', inputPath,
      '-vf', filter,
      '-an',
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '16',
      '-movflags', '+faststart',
      tmpOut,
    ],
    options,
  );

  if (res.status !== 0) {
    if (isValidVideo(tmpOut)) {
      ctx.warn('⚠ ffmpeg exited non-zero after writing a valid MP4; keeping the completed file.');
    } else {
      try { fs.unlinkSync(tmpOut); } catch (_e) { /* ignore */ }
      const detail = res.signal ? `signal ${res.signal}` : `code ${res.status}`;
      throw new Error(`ffmpeg exited with ${detail}.`);
    }
  }

  if (!isValidVideo(tmpOut)) {
    try { fs.unlinkSync(tmpOut); } catch (_e) { /* ignore */ }
    throw new Error('ffmpeg did not produce a valid MP4.');
  }

  fs.renameSync(tmpOut, outputPath);
  const sizeMB = (fs.statSync(outputPath).size / 1048576).toFixed(1);
  ctx.log(`✓ Smoothed to ${targetFps}fps → ${outputPath} (${sizeMB} MB)`);
  return { outputPath, mode };
}
