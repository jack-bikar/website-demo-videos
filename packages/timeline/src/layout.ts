import type { Clip } from '@wdv/schema';

/**
 * Output-timeline layout shared by the composition, the ffmpeg fast render path, and
 * (later) the studio's clip editor. This is the single home of the logic that used to
 * exist as two divergent copies in scripts/render.js and remotion/DemoVideo.tsx —
 * unified on render.js's semantics (numeric coercion + dropping invalid clips).
 */

export interface LayoutOptions {
  fps: number;
  /** meta.playbackSpeed — per-clip `speed` overrides it. */
  defaultSpeed: number;
  /** meta.topCropPx — per-clip `topCropPx` overrides it. */
  defaultTopCropPx?: number;
  /** Crossfade length between placed clips; 0 keeps source-contiguous flow seamless. */
  transitionFrames?: number;
}

/** Clips whose source ranges are closer than this are treated as one continuous take. */
export const JOIN_GAP_MS = 120;

export const clipSpeed = (clip: Clip, defaultSpeed: number): number => {
  const speed = Number(clip.speed);
  return Number.isFinite(speed) && speed > 0 ? speed : defaultSpeed;
};

const clipTopCrop = (clip: Clip, defaultTopCropPx: number): number =>
  Number.isFinite(clip.topCropPx) ? Number(clip.topCropPx) : defaultTopCropPx;

/**
 * Coalesce source-contiguous clips (same action, speed, crop, gap ≤ JOIN_GAP_MS) so a
 * manual split doesn't force a second video seek or a visible seam. Also sanitizes:
 * clamps negative times to 0 and drops empty/inverted clips.
 */
export function mergeContinuousClips(clips: Clip[], options: Pick<LayoutOptions, 'defaultSpeed' | 'defaultTopCropPx'>): Clip[] {
  const defaultTopCropPx = options.defaultTopCropPx ?? 0;
  const merged: Clip[] = [];
  for (const clip of clips) {
    const clean: Clip = {
      ...clip,
      start: Math.max(0, Number(clip.start) || 0),
      end: Math.max(0, Number(clip.end) || 0),
    };
    if (clean.end <= clean.start) continue;

    const prev = merged[merged.length - 1];
    const gap = prev ? clean.start - prev.end : Infinity;
    const sameAction = prev && (prev.action || '') === (clean.action || '');
    const sameSpeed = prev && Math.abs(clipSpeed(prev, options.defaultSpeed) - clipSpeed(clean, options.defaultSpeed)) < 0.001;
    const sameCrop = prev && clipTopCrop(prev, defaultTopCropPx) === clipTopCrop(clean, defaultTopCropPx);
    if (prev && gap >= 0 && gap <= JOIN_GAP_MS && sameAction && sameSpeed && sameCrop) {
      prev.end = Math.max(prev.end, clean.end);
    } else {
      merged.push(clean);
    }
  }
  return merged;
}

/** Clamp clip windows to the actual source footage length; drop clips fully outside it. */
export function clampClipsToSource(clips: Clip[], sourceDurationMs: number): Clip[] {
  if (!sourceDurationMs) return clips;
  return clips
    .map((clip) => ({
      ...clip,
      start: Math.min(clip.start, sourceDurationMs),
      end: Math.min(clip.end, sourceDurationMs),
    }))
    .filter((clip) => clip.end > clip.start);
}

export interface PlacedClip {
  clip: Clip;
  from: number;
  durationInFrames: number;
  fadeIn: number;
  fadeOut: number;
}

const msToFrames = (ms: number, fps: number) => (ms / 1000) * fps;

/** Output-frame length of a clip after its (possibly per-clip) speed-up. */
export const clipOutputFrames = (clip: Clip, options: Pick<LayoutOptions, 'fps' | 'defaultSpeed'>): number =>
  Math.max(1, Math.round(msToFrames(clip.end - clip.start, options.fps) / clipSpeed(clip, options.defaultSpeed)));

/** Lay clips on the output timeline. Merge source-contiguous clips before calling this. */
export function layoutClips(clips: Clip[], options: LayoutOptions): { placed: PlacedClip[]; totalFrames: number } {
  const transitionFrames = options.transitionFrames ?? 0;
  const dur = clips.map((c) => clipOutputFrames(c, options));
  const fadeBetween = (a: number, b: number) => Math.min(transitionFrames, Math.floor(Math.min(a, b) * 0.4));

  const placed: PlacedClip[] = [];
  let cursor = 0;
  for (let i = 0; i < clips.length; i++) {
    const fadeIn = i === 0 ? Math.min(transitionFrames, Math.floor(dur[i] * 0.4)) : fadeBetween(dur[i - 1], dur[i]);
    const fadeOut = i === clips.length - 1 ? Math.min(transitionFrames, Math.floor(dur[i] * 0.4)) : 0;
    placed.push({ clip: clips[i], from: cursor, durationInFrames: dur[i], fadeIn, fadeOut });
    const fadeToNext = i < clips.length - 1 ? fadeBetween(dur[i], dur[i + 1]) : 0;
    cursor += dur[i] - fadeToNext;
  }
  const totalFrames = placed.length ? placed[placed.length - 1].from + placed[placed.length - 1].durationInFrames : 0;
  return { placed, totalFrames };
}

/** Total output seconds across clips after speed-up (fast render path). */
export function totalOutputSeconds(clips: Clip[], defaultSpeed: number): number {
  return clips.reduce((sum, clip) => sum + (clip.end - clip.start) / 1000 / clipSpeed(clip, defaultSpeed), 0);
}

export interface FootageSegment {
  rawStart: number;
  rawDuration: number;
  outputDuration: number;
  outputFrames: number;
  speed: number;
  extraHoldSeconds?: number;
}

/**
 * Map the output timeline back to raw-footage segments, skipping the first
 * `skipOutputSeconds` of output (used when a rendered overlay covers the opening).
 * Ported from scripts/render.js footageSegmentsAfter.
 */
export function footageSegmentsAfter(
  clips: Clip[],
  skipOutputSeconds: number,
  options: Pick<LayoutOptions, 'fps' | 'defaultSpeed'>,
): FootageSegment[] {
  const segments: FootageSegment[] = [];
  let outputCursor = 0;

  for (const clip of clips) {
    const speed = clipSpeed(clip, options.defaultSpeed);
    const clipOutput = (clip.end - clip.start) / 1000 / speed;
    const overlapStart = Math.max(0, skipOutputSeconds - outputCursor);
    const overlapEnd = clipOutput;

    if (overlapStart < overlapEnd - 0.0005) {
      const rawStart = clip.start / 1000 + overlapStart * speed;
      const outputDuration = overlapEnd - overlapStart;
      segments.push({
        rawStart,
        rawDuration: outputDuration * speed,
        outputDuration,
        outputFrames: Math.max(1, Math.round(outputDuration * options.fps)),
        speed,
      });
    }

    outputCursor += clipOutput;
  }

  return segments;
}
