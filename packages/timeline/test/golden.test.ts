import { describe, expect, it } from 'vitest';
import { browsePlanSchema, clipsSchema, keyframesSchema, momentsSchema } from '@wdv/schema';
import { momentsToClips, momentsToKeyframes } from '../src';
import planFixture from './fixtures/astaxis/browse-plan.json';
import momentsFixture from './fixtures/astaxis/moments.json';
import clipsFixture from './fixtures/astaxis/clips.json';
import keyframesFixture from './fixtures/astaxis/keyframes.json';

// ffprobe duration of the recording the fixtures were generated from.
const RAW_DURATION_MS = 28720;

describe('schemas accept the real artifacts', () => {
  it('parses the committed browse plan without loss', () => {
    const parsed = browsePlanSchema.parse(planFixture);
    expect(parsed.url).toBe(planFixture.url);
    expect(parsed.steps).toHaveLength(planFixture.steps.length);
  });

  it('parses moments, clips and keyframes fixtures', () => {
    expect(momentsSchema.parse(momentsFixture)).toHaveLength(momentsFixture.length);
    expect(clipsSchema.parse(clipsFixture)).toHaveLength(clipsFixture.length);
    expect(keyframesSchema.parse(keyframesFixture)).toEqual(keyframesFixture);
  });
});

describe('golden: fixtures round-trip through the pure pipeline', () => {
  const plan = browsePlanSchema.parse(planFixture);
  const moments = momentsSchema.parse(momentsFixture);

  it('momentsToClips reproduces the committed clips.json exactly', () => {
    const clips = momentsToClips(
      moments,
      {
        leadMs: plan.meta.trimLeadMs,
        tailMs: plan.meta.trimTailMs,
        mergeMaxGapMs: plan.meta.trimMergeMaxGapMs,
        deadAirGapMs: plan.meta.trimDeadAirGapMs,
        preserveStart: plan.meta.preserveStart,
      },
      RAW_DURATION_MS,
    );
    expect(clips).toEqual(clipsFixture);
  });

  it('momentsToKeyframes reproduces the committed keyframes.json (zoom disabled → empty)', () => {
    const keyframes = momentsToKeyframes(moments, {
      zoomEnabled: plan.meta.zoom !== false,
      viewport: plan.viewport,
    });
    expect(keyframes).toEqual(keyframesFixture);
  });
});
