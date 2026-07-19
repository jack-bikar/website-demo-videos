import type { Clip, Moment } from '@wdv/schema';

/**
 * Dead-air trimming: turn recorded moments into kept clip windows.
 * Ported verbatim from scripts/trim.js — these rules are the product's look:
 *   1. each clip starts `leadMs` BEFORE its action timestamp
 *   2. each clip ends `tailMs` AFTER its action timestamp
 *   3. merge adjacent clips whose edge gap is LESS THAN `mergeMaxGapMs`
 *   4. never bridge action gaps larger than `deadAirGapMs` (this cuts the dead air)
 *   5. repeated same-action moments are an intentional held shot
 */

export interface TrimOptions {
  leadMs?: number;
  tailMs?: number;
  mergeMaxGapMs?: number;
  deadAirGapMs?: number;
  preserveStart?: boolean;
}

export const TRIM_DEFAULTS = {
  leadMs: 500,
  tailMs: 1000,
  mergeMaxGapMs: 2000,
  deadAirGapMs: 3000,
} as const;

interface WorkingClip extends Clip {
  _t: number;
  _lastAction: string;
  _lastType: string;
}

export function momentsToClips(moments: Moment[], options: TrimOptions = {}, rawDurationMs = 0): Clip[] {
  if (!Array.isArray(moments) || moments.length === 0) return [];

  const leadMs = options.leadMs ?? TRIM_DEFAULTS.leadMs;
  const tailMs = options.tailMs ?? TRIM_DEFAULTS.tailMs;
  const mergeMaxGapMs = options.mergeMaxGapMs ?? TRIM_DEFAULTS.mergeMaxGapMs;
  const deadAirGapMs = options.deadAirGapMs ?? TRIM_DEFAULTS.deadAirGapMs;

  const sorted = [...moments].sort((a, b) => a.time - b.time);

  const raw: WorkingClip[] = sorted.map((m) => ({
    start: Math.max(0, m.time - leadMs),
    end: m.time + tailMs,
    action: m.action,
    type: m.type,
    speed: m.speed,
    _t: m.time,
    _lastAction: m.action,
    _lastType: m.type,
  }));

  const clips: WorkingClip[] = [];
  let current: WorkingClip = { ...raw[0] };
  if (options.preserveStart === true) current.start = 0;

  for (let i = 1; i < raw.length; i++) {
    const next = raw[i];
    // Rule 4 is defined on action spacing, rule 3 on clip-edge spacing.
    const actionGap = next._t - current._t;
    const clipGap = next.start - current.end;

    const sameAction =
      (current._lastAction || '') === (next.action || '') && (current._lastType || '') === (next.type || '');
    const tooMuchDeadAir = !sameAction && actionGap > deadAirGapMs;
    const closeEnoughToMerge = clipGap < mergeMaxGapMs;

    if (!tooMuchDeadAir && closeEnoughToMerge) {
      current.end = Math.max(current.end, next.end);
      current._t = next._t;
      current._lastAction = next.action;
      current._lastType = next.type;
      // The first action's label stays as the merged clip's lead-in.
    } else {
      clips.push(current);
      current = { ...next };
    }
  }
  clips.push(current);

  const output = clips
    .map(({ start, end, action, type, speed }) => {
      const clampedEnd = rawDurationMs > 0 ? Math.min(end, rawDurationMs) : end;
      const clip: Clip = { start, end: clampedEnd, action, type };
      if (Number.isFinite(speed)) clip.speed = speed;
      return clip;
    })
    .filter((clip) => clip.end > clip.start);

  // A final `focus` step means "hold the closing shot" — extend it to the end of the footage.
  const finalMoment = sorted[sorted.length - 1];
  if (finalMoment && finalMoment.type === 'focus' && rawDurationMs > 0 && output.length > 0) {
    output[output.length - 1].end = rawDurationMs;
  }

  return output;
}
