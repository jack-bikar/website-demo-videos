import { describe, expect, it } from 'vitest';
import type { Moment } from '@wdv/schema';
import { momentsToClips } from '../src';

const moment = (time: number, action = 'act', type = 'click', extra: Partial<Moment> = {}): Moment => ({
  time,
  action,
  type,
  x: 100,
  y: 100,
  ...extra,
});

describe('momentsToClips rules', () => {
  it('rule 1+2: clip spans lead before to tail after the action', () => {
    expect(momentsToClips([moment(5000)])).toEqual([{ start: 4500, end: 6000, action: 'act', type: 'click' }]);
  });

  it('clamps the first clip start at 0', () => {
    expect(momentsToClips([moment(200)])[0].start).toBe(0);
  });

  it('rule 3: merges clips whose edges are closer than mergeMaxGapMs', () => {
    // Actions 3s apart → clip gap = 3000 - 1000 - 500 = 1500ms < 2000 default,
    // but action gap 3000 is NOT > deadAirGapMs 3000, so they merge.
    const clips = momentsToClips([moment(5000, 'a'), moment(8000, 'b')]);
    expect(clips).toEqual([{ start: 4500, end: 9000, action: 'a', type: 'click' }]);
  });

  it('rule 4: never bridges different actions further apart than deadAirGapMs', () => {
    const clips = momentsToClips([moment(5000, 'a'), moment(8001, 'b')]);
    expect(clips).toHaveLength(2);
  });

  it('rule 5: same-action moments merge across gaps that would split different actions', () => {
    // Action gap 3200ms exceeds deadAirGapMs (3000) so different actions split…
    expect(momentsToClips([moment(5000, 'a'), moment(8200, 'b')])).toHaveLength(2);
    // …but the same repeated action is a held shot: the dead-air rule doesn't apply.
    const held = momentsToClips([moment(5000, 'scrolling', 'scroll'), moment(8200, 'scrolling', 'scroll')]);
    expect(held).toEqual([{ start: 4500, end: 9200, action: 'scrolling', type: 'scroll' }]);
  });

  it('preserveStart pins the first clip to 0', () => {
    expect(momentsToClips([moment(5000)], { preserveStart: true })[0].start).toBe(0);
  });

  it('clamps clip ends to the raw duration and drops clips past it', () => {
    const clips = momentsToClips([moment(5000, 'a'), moment(20000, 'b')], {}, 6000);
    expect(clips).toEqual([{ start: 4500, end: 6000, action: 'a', type: 'click' }]);
  });

  it('extends the last clip to the raw duration when the final moment is a focus', () => {
    const clips = momentsToClips([moment(5000, 'a'), moment(9000, 'hold', 'focus')], {}, 20000);
    expect(clips[clips.length - 1].end).toBe(20000);
  });

  it('carries per-moment speed and splits when the next moment uses the default speed', () => {
    const clips = momentsToClips([moment(5000, 'a', 'click', { speed: 2 }), moment(8000, 'b')]);
    expect(clips).toEqual([
      { start: 4500, end: 6000, action: 'a', type: 'click', speed: 2 },
      { start: 7500, end: 9000, action: 'b', type: 'click' },
    ]);
  });

  it('keeps speed changes as clip boundaries without overlapping repeated footage', () => {
    const clips = momentsToClips([
      moment(5000, 'homepage', 'scroll', { speed: 1 }),
      moment(6200, 'homepage', 'scroll', { speed: 1 }),
      moment(7000, 'booking transition', 'click', { speed: 1.3 }),
    ]);
    expect(clips).toEqual([
      { start: 4500, end: 6500, action: 'homepage', type: 'scroll', speed: 1 },
      { start: 6500, end: 8000, action: 'booking transition', type: 'click', speed: 1.3 },
    ]);
  });

  it('sorts unordered moments before windowing', () => {
    const clips = momentsToClips([moment(8000, 'b'), moment(5000, 'a')]);
    expect(clips[0].action).toBe('a');
  });
});
