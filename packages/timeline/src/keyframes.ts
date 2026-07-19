import type { Keyframe, Moment, Viewport } from '@wdv/schema';

/**
 * Camera keyframes: for each moment emit a zoom-in (scale 1.3, centered on the action
 * point, ~300ms before) and a zoom-out (scale 1.0, ~600ms after). Ported verbatim from
 * scripts/keyframes.js. Times share the moments/clips ms domain.
 */

export const ZOOM_IN_SCALE = 1.3;
export const ZOOM_OUT_SCALE = 1.0;
export const ZOOM_IN_LEAD_MS = 300;
export const ZOOM_OUT_LAG_MS = 600;

export interface KeyframeOptions {
  /** meta.zoom !== false — when false, an empty list means a steady un-zoomed shot. */
  zoomEnabled?: boolean;
  viewport?: Viewport;
}

export function momentsToKeyframes(moments: Moment[], options: KeyframeOptions = {}): Keyframe[] {
  if (!Array.isArray(moments) || moments.length === 0) return [];
  if (options.zoomEnabled === false) return [];

  const vp = options.viewport ?? { width: 1280, height: 800 };
  const center = { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) };

  const keyframes: Keyframe[] = [];
  for (const m of moments) {
    const x = Number.isFinite(m.x) ? m.x : center.x;
    const y = Number.isFinite(m.y) ? m.y : center.y;

    keyframes.push({ time: Math.max(0, m.time - ZOOM_IN_LEAD_MS), scale: ZOOM_IN_SCALE, x, y, action: m.action, type: m.type });
    keyframes.push({ time: m.time + ZOOM_OUT_LAG_MS, scale: ZOOM_OUT_SCALE, x, y, action: m.action, type: m.type });
  }

  keyframes.sort((a, b) => a.time - b.time);
  return keyframes;
}
