import { Moment, Clip, Viewport, Keyframe } from '@wdv/schema';
export { Clip, Keyframe, Moment, Viewport } from '@wdv/schema';

/**
 * Dead-air trimming: turn recorded moments into kept clip windows.
 * Ported verbatim from scripts/trim.js — these rules are the product's look:
 *   1. each clip starts `leadMs` BEFORE its action timestamp
 *   2. each clip ends `tailMs` AFTER its action timestamp
 *   3. merge adjacent clips whose edge gap is LESS THAN `mergeMaxGapMs`
 *   4. never bridge action gaps larger than `deadAirGapMs` (this cuts the dead air)
 *   5. repeated same-action moments are an intentional held shot
 */
interface TrimOptions {
    leadMs?: number;
    tailMs?: number;
    mergeMaxGapMs?: number;
    deadAirGapMs?: number;
    preserveStart?: boolean;
}
declare const TRIM_DEFAULTS: {
    readonly leadMs: 500;
    readonly tailMs: 1000;
    readonly mergeMaxGapMs: 2000;
    readonly deadAirGapMs: 3000;
};
declare function momentsToClips(moments: Moment[], options?: TrimOptions, rawDurationMs?: number): Clip[];

/**
 * Camera keyframes: for each moment emit a zoom-in (scale 1.3, centered on the action
 * point, ~300ms before) and a zoom-out (scale 1.0, ~600ms after). Ported verbatim from
 * scripts/keyframes.js. Times share the moments/clips ms domain.
 */
declare const ZOOM_IN_SCALE = 1.3;
declare const ZOOM_OUT_SCALE = 1;
declare const ZOOM_IN_LEAD_MS = 300;
declare const ZOOM_OUT_LAG_MS = 600;
interface KeyframeOptions {
    /** meta.zoom !== false — when false, an empty list means a steady un-zoomed shot. */
    zoomEnabled?: boolean;
    viewport?: Viewport;
}
declare function momentsToKeyframes(moments: Moment[], options?: KeyframeOptions): Keyframe[];

/**
 * Output-timeline layout shared by the composition, the ffmpeg fast render path, and
 * (later) the studio's clip editor. This is the single home of the logic that used to
 * exist as two divergent copies in scripts/render.js and remotion/DemoVideo.tsx —
 * unified on render.js's semantics (numeric coercion + dropping invalid clips).
 */
interface LayoutOptions {
    fps: number;
    /** meta.playbackSpeed — per-clip `speed` overrides it. */
    defaultSpeed: number;
    /** meta.topCropPx — per-clip `topCropPx` overrides it. */
    defaultTopCropPx?: number;
    /** Crossfade length between placed clips; 0 keeps source-contiguous flow seamless. */
    transitionFrames?: number;
}
/** Clips whose source ranges are closer than this are treated as one continuous take. */
declare const JOIN_GAP_MS = 120;
declare const clipSpeed: (clip: Clip, defaultSpeed: number) => number;
/**
 * Coalesce source-contiguous clips (same action, speed, crop, gap ≤ JOIN_GAP_MS) so a
 * manual split doesn't force a second video seek or a visible seam. Also sanitizes:
 * clamps negative times to 0 and drops empty/inverted clips.
 */
declare function mergeContinuousClips(clips: Clip[], options: Pick<LayoutOptions, 'defaultSpeed' | 'defaultTopCropPx'>): Clip[];
/** Clamp clip windows to the actual source footage length; drop clips fully outside it. */
declare function clampClipsToSource(clips: Clip[], sourceDurationMs: number): Clip[];
interface PlacedClip {
    clip: Clip;
    from: number;
    durationInFrames: number;
    fadeIn: number;
    fadeOut: number;
}
/** Output-frame length of a clip after its (possibly per-clip) speed-up. */
declare const clipOutputFrames: (clip: Clip, options: Pick<LayoutOptions, "fps" | "defaultSpeed">) => number;
/** Lay clips on the output timeline. Merge source-contiguous clips before calling this. */
declare function layoutClips(clips: Clip[], options: LayoutOptions): {
    placed: PlacedClip[];
    totalFrames: number;
};
/** Total output seconds across clips after speed-up (fast render path). */
declare function totalOutputSeconds(clips: Clip[], defaultSpeed: number): number;
interface FootageSegment {
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
declare function footageSegmentsAfter(clips: Clip[], skipOutputSeconds: number, options: Pick<LayoutOptions, 'fps' | 'defaultSpeed'>): FootageSegment[];

export { type FootageSegment, JOIN_GAP_MS, type KeyframeOptions, type LayoutOptions, type PlacedClip, TRIM_DEFAULTS, type TrimOptions, ZOOM_IN_LEAD_MS, ZOOM_IN_SCALE, ZOOM_OUT_LAG_MS, ZOOM_OUT_SCALE, clampClipsToSource, clipOutputFrames, clipSpeed, footageSegmentsAfter, layoutClips, mergeContinuousClips, momentsToClips, momentsToKeyframes, totalOutputSeconds };
