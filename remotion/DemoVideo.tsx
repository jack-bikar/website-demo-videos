import React from 'react';
import {
  AbsoluteFill,
  Easing,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import clipsData from '../scripts/clips.json';
import keyframesData from '../scripts/keyframes.json';

// ---- Tunables -------------------------------------------------------------
export const FPS = 60;
export const PLAYBACK_SPEED = 4; // captured footage is played back at 4x

// The browser captured at this size; the composition matches it (see Root.tsx).
const VIDEO_W = 1280;
const VIDEO_H = 800;
// Scale the framed unit down so the gradient background shows as a margin.
const BASE_FIT = 0.86;
const ZOOM_SCALE = 1.3;

// ---- Types ----------------------------------------------------------------
export type Clip = { start: number; end: number; action: string; type: string };
type Keyframe = { time: number; scale: number; x: number; y: number; action: string; type: string };

const clips = clipsData as Clip[];
const keyframes = keyframesData as Keyframe[];

const msToFrames = (ms: number) => (ms / 1000) * FPS;

/** Output-frame length of a clip after the 4x speed-up. */
const clipOutputFrames = (clip: Clip) => Math.max(1, Math.round(msToFrames(clip.end - clip.start) / PLAYBACK_SPEED));

// ---- Camera (zoom) --------------------------------------------------------
/**
 * Drives a smooth zoom for a single clip. Keyframes whose timestamps fall inside the clip
 * are mapped onto the clip's local (sped-up) output timeline, then interpolate() animates
 * scale + focal point between them. spring() adds a soft settle on the focal point so the
 * camera eases rather than snapping.
 */
const ClipCamera: React.FC<{ clip: Clip; children: React.ReactNode }> = ({ clip, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const local = keyframes
    .filter((k) => k.time >= clip.start && k.time <= clip.end)
    .map((k) => ({
      frame: Math.max(0, Math.round(msToFrames(k.time - clip.start) / PLAYBACK_SPEED)),
      scale: k.scale,
      x: k.x,
      y: k.y,
    }))
    .sort((a, b) => a.frame - b.frame);

  let scale = 1;
  let originX = VIDEO_W / 2;
  let originY = VIDEO_H / 2;

  if (local.length === 1) {
    scale = local[0].scale;
    originX = local[0].x;
    originY = local[0].y;
  } else if (local.length >= 2) {
    const frames = local.map((k) => k.frame);
    scale = interpolate(frame, frames, local.map((k) => k.scale), {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.inOut(Easing.ease),
    });
    originX = interpolate(frame, frames, local.map((k) => k.x), {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    originY = interpolate(frame, frames, local.map((k) => k.y), {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  }

  // Soft spring settle (0 → 1) blends the resting frame toward the interpolated zoom,
  // so the very start of each clip eases in instead of popping.
  const settle = spring({ frame, fps, config: { damping: 200, mass: 0.6 }, durationInFrames: 18 });
  const easedScale = 1 + (scale - 1) * settle;

  return (
    <div
      style={{
        width: VIDEO_W,
        height: VIDEO_H,
        transform: `scale(${easedScale})`,
        transformOrigin: `${originX}px ${originY}px`,
      }}
    >
      {children}
    </div>
  );
};

// ---- Browser chrome -------------------------------------------------------
const BrowserFrame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      borderRadius: 16,
      overflow: 'hidden',
      boxShadow: '0 40px 120px rgba(0, 0, 0, 0.55), 0 8px 24px rgba(0, 0, 0, 0.35)',
      background: '#0b1020',
      border: '1px solid rgba(255, 255, 255, 0.08)',
    }}
  >
    <div
      style={{
        height: 36,
        background: 'linear-gradient(180deg, #1b2336 0%, #141a2b 100%)',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 16,
        gap: 8,
      }}
    >
      {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
        <div key={c} style={{ width: 12, height: 12, borderRadius: '50%', background: c }} />
      ))}
    </div>
    <div style={{ width: VIDEO_W, height: VIDEO_H, position: 'relative', overflow: 'hidden' }}>{children}</div>
  </div>
);

// ---- Composition ----------------------------------------------------------
export const DemoVideo: React.FC = () => {
  // Cumulative output-frame offset for each clip Sequence.
  let cursor = 0;
  const placed = clips.map((clip) => {
    const from = cursor;
    const durationInFrames = clipOutputFrames(clip);
    cursor += durationInFrames;
    return { clip, from, durationInFrames };
  });

  return (
    <AbsoluteFill
      style={{
        // Dark navy → indigo gradient, suited to a SaaS product.
        background: 'linear-gradient(135deg, #0a0f24 0%, #131a3a 45%, #2a2065 100%)',
      }}
    >
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ transform: `scale(${BASE_FIT})` }}>
          <BrowserFrame>
            {placed.map(({ clip, from, durationInFrames }, i) => (
              <Sequence key={i} from={from} durationInFrames={durationInFrames}>
                <ClipCamera clip={clip}>
                  <OffthreadVideo
                    src={staticFile('raw.mp4')}
                    startFrom={Math.round(msToFrames(clip.start))}
                    playbackRate={PLAYBACK_SPEED}
                    muted
                    style={{ width: VIDEO_W, height: VIDEO_H, objectFit: 'cover' }}
                  />
                </ClipCamera>
              </Sequence>
            ))}
          </BrowserFrame>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
