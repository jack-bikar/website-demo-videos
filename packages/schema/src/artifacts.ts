import { z } from 'zod';
import { planMetaSchema, viewportSchema } from './plan';

/**
 * Pipeline artifacts. Times are always milliseconds relative to the start of the
 * raw recording, so moments, clips and keyframes share one time domain.
 */

export const momentSchema = z
  .object({
    time: z.number().nonnegative(),
    action: z.string(),
    type: z.string(),
    x: z.number(),
    y: z.number(),
    speed: z.number().positive().optional(),
  })
  .strict();
export type Moment = z.infer<typeof momentSchema>;

export const clipSchema = z
  .object({
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    action: z.string(),
    type: z.string(),
    speed: z.number().positive().optional(),
    topCropPx: z.number().nonnegative().optional(),
  })
  .strict();
export type Clip = z.infer<typeof clipSchema>;

export const keyframeSchema = z
  .object({
    time: z.number().nonnegative(),
    scale: z.number().positive(),
    x: z.number(),
    y: z.number(),
    action: z.string(),
    type: z.string(),
  })
  .strict();
export type Keyframe = z.infer<typeof keyframeSchema>;

export const momentsSchema = z.array(momentSchema);
export const clipsSchema = z.array(clipSchema);
export const keyframesSchema = z.array(keyframeSchema);

/**
 * Typed input for the walkthrough composition. The composition renders these props and
 * nothing else — no staticFile/JSON imports — so the Player (browser URL) and the
 * renderer (publicDir-relative file) share one component.
 */
export const demoVideoPropsSchema = z
  .object({
    /** http(s) URL (Player) or a publicDir-relative filename resolved via staticFile (renderer). */
    videoSrc: z.string(),
    viewport: viewportSchema,
    clips: clipsSchema,
    keyframes: keyframesSchema,
    meta: planMetaSchema,
  })
  .strict();
export type DemoVideoProps = z.infer<typeof demoVideoPropsSchema>;
