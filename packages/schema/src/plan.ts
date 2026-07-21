import { z } from 'zod';

/**
 * The browse plan is the single config that drives a walkthrough capture.
 * These schemas formalize exactly what scripts/record.js, trim.js, keyframes.js,
 * render.js and the composition read today — no extra fields, no passthrough.
 */

export const stepTypeSchema = z.enum(['navigate', 'click', 'type', 'scroll', 'wait', 'focus', 'capture']);
export type StepType = z.infer<typeof stepTypeSchema>;

export const stepPaceSchema = z.enum(['very-slow', 'slow', 'normal', 'quick']);
export type StepPace = z.infer<typeof stepPaceSchema>;

export const stepSmoothnessSchema = z.enum(['standard', 'continuous']);
export type StepSmoothness = z.infer<typeof stepSmoothnessSchema>;

// Legacy plans use one loose step object rather than a strict discriminated union;
// which optional fields apply depends on `type` (validated at execution time by the
// recorder, which tolerates missing selectors by screenshotting and continuing).
export const stepSchema = z
  .object({
    type: stepTypeSchema,
    /** Caption/log line; also becomes the moment's `action` label. */
    why: z.string(),
    /** CSS selector (click/type/focus/capture) or URL (navigate). */
    target: z.string().optional(),
    /** navigate: puppeteer waitUntil condition. */
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).optional(),
    /** Suppress the moment (no clip is kept around this step). */
    silent: z.boolean().optional(),
    /** Human-facing creative direction for this scene; kept with the plan for review. */
    direction: z.string().optional(),
    /** Named playback pacing; explicit `speed` still wins when both are present. */
    pace: stepPaceSchema.optional(),
    /** scroll: "continuous" uses constant movement and denser trim waypoints. */
    smoothness: stepSmoothnessSchema.optional(),
    /** wait/scroll/focus: duration in ms. */
    ms: z.number().optional(),
    /** scroll: total pixels to scroll. */
    deltaY: z.number().optional(),
    /** scroll: constant-velocity scroll instead of eased. */
    linear: z.boolean().optional(),
    /** scroll: allow scrolling into the footer (normally clamped). */
    allowFooter: z.boolean().optional(),
    /** type: text to type; supports {{var}} templating from earlier capture steps. */
    text: z.string().optional(),
    /** focus: ms spent fitting the target into view before resting. */
    fitMs: z.number().optional(),
    /** capture: variable name the captured text is stored under. */
    as: z.string().optional(),
    /** Per-section playback speed override honored by the composition. */
    speed: z.number().positive().optional(),
    /** Caption override for this step's clip. */
    caption: z.string().optional(),
    /** click: selector retry attempts. */
    retries: z.number().int().nonnegative().optional(),
    /** click: selector wait timeout in ms. */
    timeoutMs: z.number().nonnegative().optional(),
  })
  .strict();
export type Step = z.infer<typeof stepSchema>;

export const recordingModeSchema = z.enum(['cloud', 'local', 'connect']);
export type RecordingMode = z.infer<typeof recordingModeSchema>;

export const recordingConfigSchema = z
  .object({
    mode: recordingModeSchema.optional(),
    connectUrl: z.string().nullable().optional(),
    headful: z.boolean().optional(),
    userDataDir: z.string().nullable().optional(),
    chromePath: z.string().nullable().optional(),
    stepPauseMs: z.number().nonnegative().optional(),
    screencastQuality: z.number().min(1).max(100).optional(),
    /** Guaranteed constant capture cadence in fps. The screencast fills in as fast as Chrome
     *  composites; this floor force-captures a frame whenever it stalls (static holds, throttled
     *  scrolls) so motion never drops below a steady rate. */
    captureFps: z.number().min(10).max(60).optional(),
  })
  .strict();
export type RecordingConfig = z.infer<typeof recordingConfigSchema>;

export const titleCardSchema = z
  .object({
    title: z.string().default(''),
    subtitle: z.string().default(''),
  })
  .strict();
export type TitleCard = z.infer<typeof titleCardSchema>;

export const renderQualitySchema = z.enum(['draft', 'standard', 'final']);
export type RenderQuality = z.infer<typeof renderQualitySchema>;

export const smoothModeSchema = z.enum(['auto', 'mci', 'blend', 'fps']);
export type SmoothModeSetting = z.infer<typeof smoothModeSchema>;

/** Pluggable brand overlay shown while the site "loads" (replaces the legacy hardcoded one). */
export const overlaySpecSchema = z
  .object({
    /** Key into the composition-side overlay registry. */
    id: z.string(),
    seconds: z.number().positive().default(3),
    /** Overlay-specific props, validated by the overlay component's own schema. */
    props: z.record(z.unknown()).default({}),
  })
  .strict();
export type OverlaySpec = z.infer<typeof overlaySpecSchema>;

export const planMetaSchema = z
  .object({
    title: z.string().optional(),
    subtitle: z.string().optional(),
    intro: titleCardSchema.nullable().optional(),
    outro: titleCardSchema.nullable().optional(),
    playbackSpeed: z.number().positive().optional(),
    captions: z.boolean().optional(),
    zoom: z.boolean().optional(),
    preserveStart: z.boolean().optional(),
    trimLeadMs: z.number().nonnegative().optional(),
    trimTailMs: z.number().nonnegative().optional(),
    trimMergeMaxGapMs: z.number().nonnegative().optional(),
    trimDeadAirGapMs: z.number().nonnegative().optional(),
    /** @deprecated legacy toggle for the hardcoded brand overlay — use `overlay`. */
    loadingOverlay: z.boolean().optional(),
    /** @deprecated use `overlay.seconds`. */
    loadingOverlaySeconds: z.number().positive().optional(),
    overlay: overlaySpecSchema.nullable().optional(),
    topCropPx: z.number().nonnegative().optional(),
    finalSettleMs: z.number().nonnegative().optional(),
    finalHoldSeconds: z.number().nonnegative().optional(),
    /** Frame interpolation mode. Use "mci" for scroll-heavy walkthroughs. */
    smoothMode: smoothModeSchema.optional(),
    renderQuality: renderQualitySchema.optional(),
  })
  .strict();
export type PlanMeta = z.infer<typeof planMetaSchema>;

/**
 * Normalize the deprecated loadingOverlay/loadingOverlaySeconds pair into an OverlaySpec.
 * Legacy plans keep validating; new code only ever sees `overlay`.
 */
export function resolveOverlay(meta: PlanMeta): OverlaySpec | null {
  if (meta.overlay !== undefined) return meta.overlay;
  if (meta.loadingOverlay === true) {
    return { id: 'brand-intro', seconds: meta.loadingOverlaySeconds ?? 3, props: {} };
  }
  return null;
}

export const viewportSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export type Viewport = z.infer<typeof viewportSchema>;

export const browsePlanSchema = z
  .object({
    url: z.string().url(),
    viewport: viewportSchema.default({ width: 1280, height: 800 }),
    /** Exact text snippets hidden on the page before recording (demo disclaimers etc.). */
    hideText: z.array(z.string()).optional(),
    recording: recordingConfigSchema.optional(),
    meta: planMetaSchema.default({}),
    steps: z.array(stepSchema).min(1),
  })
  .strict();
export type BrowsePlan = z.infer<typeof browsePlanSchema>;
