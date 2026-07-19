import { z } from 'zod';
import { clipSchema, keyframeSchema } from './artifacts';
import { overlaySpecSchema, titleCardSchema } from './plan';

/**
 * The mode-agnostic storyboard model. Every generation mode compiles its inputs and
 * captured artifacts into a Storyboard; compositions render Storyboards and nothing else.
 * Scenes are a discriminated union so one polymorphic `scenes` DB table (kind + payload)
 * covers all modes.
 */

export const rectSchema = z
  .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
  .strict();
export type Rect = z.infer<typeof rectSchema>;

export const gradientSpecSchema = z
  .object({
    kind: z.enum(['linear', 'mesh']).default('linear'),
    colors: z.array(z.string()).min(2),
    angle: z.number().default(135),
    /** Subtle animated drift of the gradient over the scene. */
    drift: z.boolean().default(true),
  })
  .strict();
export type GradientSpec = z.infer<typeof gradientSpecSchema>;

/** Walkthrough footage clip on the output timeline. */
export const videoClipSceneSchema = z
  .object({
    kind: z.literal('videoClip'),
    clip: clipSchema,
    keyframes: z.array(keyframeSchema).default([]),
  })
  .strict();

/** Screenshot with a Ken Burns camera move, optionally in a device frame. */
export const imageMotionSceneSchema = z
  .object({
    kind: z.literal('imageMotion'),
    /** Artifact id resolved to a URL/path by the AssetResolver at props-build time. */
    imageRef: z.string(),
    durationMs: z.number().positive(),
    frame: z.enum(['none', 'browser', 'phone']).default('none'),
    /** Shown in the browser frame's URL bar when frame === 'browser'. */
    frameUrl: z.string().optional(),
    motion: z
      .object({
        from: rectSchema,
        to: rectSchema,
        easing: z.enum(['ease', 'easeIn', 'easeOut', 'linear', 'spring']).default('ease'),
      })
      .strict(),
    backdrop: gradientSpecSchema.optional(),
    transitionIn: z.enum(['none', 'fade', 'slide', 'wipe', 'scaleThrough']).default('fade'),
    caption: z.string().optional(),
  })
  .strict();

export const wordTimingSchema = z
  .object({ word: z.string(), startMs: z.number().nonnegative(), endMs: z.number().nonnegative() })
  .strict();
export type WordTiming = z.infer<typeof wordTimingSchema>;

/** One caption beat of a short. The composition renders beats and never knows whether
 *  timings came from heuristics or TTS word timestamps — that is the TTS seam. */
export const textBeatSceneSchema = z
  .object({
    kind: z.literal('textBeat'),
    text: z.string(),
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
    words: z.array(wordTimingSchema).optional(),
    /** Background media (screenshot or footage artifact) shown behind the text. */
    media: z
      .object({
        ref: z.string(),
        type: z.enum(['image', 'video']),
        motion: z.object({ from: rectSchema, to: rectSchema }).strict().optional(),
      })
      .strict()
      .optional(),
    style: z.enum(['boldPop', 'lowerThird', 'karaoke']).default('boldPop'),
  })
  .strict();

/** Full-screen intro/outro card. */
export const cardSceneSchema = z
  .object({
    kind: z.literal('card'),
    card: titleCardSchema,
    durationMs: z.number().positive(),
    variant: z.enum(['intro', 'outro']).default('intro'),
  })
  .strict();

export const sceneSchema = z.discriminatedUnion('kind', [
  videoClipSceneSchema,
  imageMotionSceneSchema,
  textBeatSceneSchema,
  cardSceneSchema,
]);
export type Scene = z.infer<typeof sceneSchema>;

export const audioTrackSchema = z
  .object({
    kind: z.enum(['music', 'voiceover', 'sfx']),
    ref: z.string(),
    startMs: z.number().nonnegative().default(0),
    volume: z.number().min(0).max(1).default(1),
    /** Lower music under voiceover by this many dB. */
    duckDb: z.number().optional(),
  })
  .strict();
export type AudioTrack = z.infer<typeof audioTrackSchema>;

export const themeSchema = z
  .object({
    accentColor: z.string().optional(),
    background: z.string().optional(),
    fontFamily: z.string().optional(),
  })
  .strict();
export type Theme = z.infer<typeof themeSchema>;

export const generationModeIdSchema = z.enum(['walkthrough', 'screenshot', 'shorts']);
export type GenerationModeId = z.infer<typeof generationModeIdSchema>;

export const storyboardSchema = z
  .object({
    id: z.string(),
    modeId: generationModeIdSchema,
    scenes: z.array(sceneSchema),
    audio: z.array(audioTrackSchema).default([]),
    theme: themeSchema.default({}),
    overlay: overlaySpecSchema.nullable().default(null),
  })
  .strict();
export type Storyboard = z.infer<typeof storyboardSchema>;
