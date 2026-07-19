// src/trim.ts
var TRIM_DEFAULTS = {
  leadMs: 500,
  tailMs: 1e3,
  mergeMaxGapMs: 2e3,
  deadAirGapMs: 3e3
};
function momentsToClips(moments, options = {}, rawDurationMs = 0) {
  if (!Array.isArray(moments) || moments.length === 0) return [];
  const leadMs = options.leadMs ?? TRIM_DEFAULTS.leadMs;
  const tailMs = options.tailMs ?? TRIM_DEFAULTS.tailMs;
  const mergeMaxGapMs = options.mergeMaxGapMs ?? TRIM_DEFAULTS.mergeMaxGapMs;
  const deadAirGapMs = options.deadAirGapMs ?? TRIM_DEFAULTS.deadAirGapMs;
  const sorted = [...moments].sort((a, b) => a.time - b.time);
  const raw = sorted.map((m) => ({
    start: Math.max(0, m.time - leadMs),
    end: m.time + tailMs,
    action: m.action,
    type: m.type,
    speed: m.speed,
    _t: m.time,
    _lastAction: m.action,
    _lastType: m.type
  }));
  const clips = [];
  let current = { ...raw[0] };
  if (options.preserveStart === true) current.start = 0;
  for (let i = 1; i < raw.length; i++) {
    const next = raw[i];
    const actionGap = next._t - current._t;
    const clipGap = next.start - current.end;
    const sameAction = (current._lastAction || "") === (next.action || "") && (current._lastType || "") === (next.type || "");
    const tooMuchDeadAir = !sameAction && actionGap > deadAirGapMs;
    const closeEnoughToMerge = clipGap < mergeMaxGapMs;
    if (!tooMuchDeadAir && closeEnoughToMerge) {
      current.end = Math.max(current.end, next.end);
      current._t = next._t;
      current._lastAction = next.action;
      current._lastType = next.type;
    } else {
      clips.push(current);
      current = { ...next };
    }
  }
  clips.push(current);
  const output = clips.map(({ start, end, action, type, speed }) => {
    const clampedEnd = rawDurationMs > 0 ? Math.min(end, rawDurationMs) : end;
    const clip = { start, end: clampedEnd, action, type };
    if (Number.isFinite(speed)) clip.speed = speed;
    return clip;
  }).filter((clip) => clip.end > clip.start);
  const finalMoment = sorted[sorted.length - 1];
  if (finalMoment && finalMoment.type === "focus" && rawDurationMs > 0 && output.length > 0) {
    output[output.length - 1].end = rawDurationMs;
  }
  return output;
}

// src/keyframes.ts
var ZOOM_IN_SCALE = 1.3;
var ZOOM_OUT_SCALE = 1;
var ZOOM_IN_LEAD_MS = 300;
var ZOOM_OUT_LAG_MS = 600;
function momentsToKeyframes(moments, options = {}) {
  if (!Array.isArray(moments) || moments.length === 0) return [];
  if (options.zoomEnabled === false) return [];
  const vp = options.viewport ?? { width: 1280, height: 800 };
  const center = { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) };
  const keyframes = [];
  for (const m of moments) {
    const x = Number.isFinite(m.x) ? m.x : center.x;
    const y = Number.isFinite(m.y) ? m.y : center.y;
    keyframes.push({ time: Math.max(0, m.time - ZOOM_IN_LEAD_MS), scale: ZOOM_IN_SCALE, x, y, action: m.action, type: m.type });
    keyframes.push({ time: m.time + ZOOM_OUT_LAG_MS, scale: ZOOM_OUT_SCALE, x, y, action: m.action, type: m.type });
  }
  keyframes.sort((a, b) => a.time - b.time);
  return keyframes;
}

// src/layout.ts
var JOIN_GAP_MS = 120;
var clipSpeed = (clip, defaultSpeed) => {
  const speed = Number(clip.speed);
  return Number.isFinite(speed) && speed > 0 ? speed : defaultSpeed;
};
var clipTopCrop = (clip, defaultTopCropPx) => Number.isFinite(clip.topCropPx) ? Number(clip.topCropPx) : defaultTopCropPx;
function mergeContinuousClips(clips, options) {
  const defaultTopCropPx = options.defaultTopCropPx ?? 0;
  const merged = [];
  for (const clip of clips) {
    const clean = {
      ...clip,
      start: Math.max(0, Number(clip.start) || 0),
      end: Math.max(0, Number(clip.end) || 0)
    };
    if (clean.end <= clean.start) continue;
    const prev = merged[merged.length - 1];
    const gap = prev ? clean.start - prev.end : Infinity;
    const sameAction = prev && (prev.action || "") === (clean.action || "");
    const sameSpeed = prev && Math.abs(clipSpeed(prev, options.defaultSpeed) - clipSpeed(clean, options.defaultSpeed)) < 1e-3;
    const sameCrop = prev && clipTopCrop(prev, defaultTopCropPx) === clipTopCrop(clean, defaultTopCropPx);
    if (prev && gap >= 0 && gap <= JOIN_GAP_MS && sameAction && sameSpeed && sameCrop) {
      prev.end = Math.max(prev.end, clean.end);
    } else {
      merged.push(clean);
    }
  }
  return merged;
}
function clampClipsToSource(clips, sourceDurationMs) {
  if (!sourceDurationMs) return clips;
  return clips.map((clip) => ({
    ...clip,
    start: Math.min(clip.start, sourceDurationMs),
    end: Math.min(clip.end, sourceDurationMs)
  })).filter((clip) => clip.end > clip.start);
}
var msToFrames = (ms, fps) => ms / 1e3 * fps;
var clipOutputFrames = (clip, options) => Math.max(1, Math.round(msToFrames(clip.end - clip.start, options.fps) / clipSpeed(clip, options.defaultSpeed)));
function layoutClips(clips, options) {
  const transitionFrames = options.transitionFrames ?? 0;
  const dur = clips.map((c) => clipOutputFrames(c, options));
  const fadeBetween = (a, b) => Math.min(transitionFrames, Math.floor(Math.min(a, b) * 0.4));
  const placed = [];
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
function totalOutputSeconds(clips, defaultSpeed) {
  return clips.reduce((sum, clip) => sum + (clip.end - clip.start) / 1e3 / clipSpeed(clip, defaultSpeed), 0);
}
function footageSegmentsAfter(clips, skipOutputSeconds, options) {
  const segments = [];
  let outputCursor = 0;
  for (const clip of clips) {
    const speed = clipSpeed(clip, options.defaultSpeed);
    const clipOutput = (clip.end - clip.start) / 1e3 / speed;
    const overlapStart = Math.max(0, skipOutputSeconds - outputCursor);
    const overlapEnd = clipOutput;
    if (overlapStart < overlapEnd - 5e-4) {
      const rawStart = clip.start / 1e3 + overlapStart * speed;
      const outputDuration = overlapEnd - overlapStart;
      segments.push({
        rawStart,
        rawDuration: outputDuration * speed,
        outputDuration,
        outputFrames: Math.max(1, Math.round(outputDuration * options.fps)),
        speed
      });
    }
    outputCursor += clipOutput;
  }
  return segments;
}
export {
  JOIN_GAP_MS,
  TRIM_DEFAULTS,
  ZOOM_IN_LEAD_MS,
  ZOOM_IN_SCALE,
  ZOOM_OUT_LAG_MS,
  ZOOM_OUT_SCALE,
  clampClipsToSource,
  clipOutputFrames,
  clipSpeed,
  footageSegmentsAfter,
  layoutClips,
  mergeContinuousClips,
  momentsToClips,
  momentsToKeyframes,
  totalOutputSeconds
};
