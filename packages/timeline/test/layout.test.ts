import { describe, expect, it } from 'vitest';
import type { Clip } from '@wdv/schema';
import {
  clampClipsToSource,
  clipOutputFrames,
  footageSegmentsAfter,
  layoutClips,
  mergeContinuousClips,
  totalOutputSeconds,
} from '../src';

const clip = (start: number, end: number, extra: Partial<Clip> = {}): Clip => ({
  start,
  end,
  action: 'act',
  type: 'click',
  ...extra,
});

const OPTS = { fps: 60, defaultSpeed: 4 };

describe('mergeContinuousClips', () => {
  it('coalesces source-contiguous clips with identical action/speed/crop', () => {
    const merged = mergeContinuousClips([clip(0, 1000), clip(1100, 2000)], OPTS);
    expect(merged).toEqual([clip(0, 2000)]);
  });

  it('keeps clips separate past the join gap', () => {
    expect(mergeContinuousClips([clip(0, 1000), clip(1200, 2000)], OPTS)).toHaveLength(2);
  });

  it('keeps clips separate when speeds differ', () => {
    expect(mergeContinuousClips([clip(0, 1000), clip(1050, 2000, { speed: 2 })], OPTS)).toHaveLength(2);
  });

  it('drops inverted/empty clips and clamps negatives (render.js semantics)', () => {
    const merged = mergeContinuousClips([clip(-500, -100), clip(500, 500), clip(1000, 2000)], OPTS);
    expect(merged).toEqual([clip(1000, 2000)]);
  });

  it('respects the default top crop when comparing per-clip crops', () => {
    const merged = mergeContinuousClips(
      [clip(0, 1000), clip(1050, 2000, { topCropPx: 80 })],
      { ...OPTS, defaultTopCropPx: 80 },
    );
    expect(merged).toHaveLength(1);
  });
});

describe('layout math', () => {
  it('clipOutputFrames divides by speed and rounds', () => {
    // 4000ms at 60fps / speed 4 = 60 frames
    expect(clipOutputFrames(clip(0, 4000), OPTS)).toBe(60);
    expect(clipOutputFrames(clip(0, 4000, { speed: 2 }), OPTS)).toBe(120);
  });

  it('layoutClips places clips back to back with zero transitions', () => {
    const { placed, totalFrames } = layoutClips([clip(0, 4000), clip(8000, 12000)], OPTS);
    expect(placed.map((p) => p.from)).toEqual([0, 60]);
    expect(totalFrames).toBe(120);
    expect(placed.every((p) => p.fadeIn === 0 && p.fadeOut === 0)).toBe(true);
  });

  it('totalOutputSeconds honors per-clip speed', () => {
    expect(totalOutputSeconds([clip(0, 4000), clip(4000, 8000, { speed: 2 })], 4)).toBeCloseTo(1 + 2);
  });

  it('clampClipsToSource trims to footage length', () => {
    expect(clampClipsToSource([clip(0, 4000), clip(5000, 9000)], 4500)).toEqual([clip(0, 4000)]);
  });
});

describe('footageSegmentsAfter', () => {
  it('maps output time back to raw segments with no skip', () => {
    const segments = footageSegmentsAfter([clip(1000, 5000)], 0, OPTS);
    expect(segments).toEqual([
      { rawStart: 1, rawDuration: 4, outputDuration: 1, outputFrames: 60, speed: 4 },
    ]);
  });

  it('skips output covered by an overlay, resuming mid-clip at the right raw offset', () => {
    // Clip outputs 1s; skip 0.5s → segment starts 0.5*4=2s into the clip's raw range.
    const segments = footageSegmentsAfter([clip(1000, 5000)], 0.5, OPTS);
    expect(segments).toHaveLength(1);
    expect(segments[0].rawStart).toBeCloseTo(3);
    expect(segments[0].outputDuration).toBeCloseTo(0.5);
  });

  it('drops clips entirely covered by the skip', () => {
    const segments = footageSegmentsAfter([clip(0, 4000), clip(4000, 8000)], 1, OPTS);
    expect(segments).toHaveLength(1);
    expect(segments[0].rawStart).toBeCloseTo(4);
  });
});
