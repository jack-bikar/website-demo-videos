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
import browsePlan from '../scripts/browse-plan.json';

// ---- Types ----------------------------------------------------------------
export type Clip = { start: number; end: number; action: string; type: string; speed?: number };
type Keyframe = { time: number; scale: number; x: number; y: number; action: string; type: string };
type Card = { title: string; subtitle: string };
type Meta = {
  title?: string;
  subtitle?: string;
  intro?: Card | null;
  outro?: Card | null;
  playbackSpeed?: number;
  captions?: boolean;
};

const clips = clipsData as Clip[];
const keyframes = keyframesData as Keyframe[];
// Everything is configured in one file: the composition reads its `meta` straight from the
// browse plan, so there's no second config to keep in sync.
const meta = ((browsePlan as { meta?: Meta }).meta ?? {}) as Meta;

const asCard = (c?: Card | null): Card | null =>
  c && (c.title || c.subtitle) ? { title: c.title || '', subtitle: c.subtitle || '' } : null;

// ---- Tunables -------------------------------------------------------------
export const FPS = 60;

// Captured footage is sped up on playback. The default is configurable via the plan's
// `meta.playbackSpeed`, and any individual clip can override it with a `speed` field — so a fast
// click-through and a slower form-fill can live in the same demo. 4x stays the default.
export const DEFAULT_PLAYBACK_SPEED = Number.isFinite(meta.playbackSpeed) ? (meta.playbackSpeed as number) : 4;
// Back-compat export for modules that imported the old constant name.
export const PLAYBACK_SPEED = DEFAULT_PLAYBACK_SPEED;

const clipSpeed = (clip: Clip) => (Number.isFinite(clip.speed) ? (clip.speed as number) : DEFAULT_PLAYBACK_SPEED);

// Caption track (lower-third subtitles + intro/outro cards). Intro/outro only render when the
// plan's `meta` provides them; the per-clip lower-thirds use each clip's authored `action`.
const captionsEnabled = meta.captions !== false;
const introCard = captionsEnabled
  ? asCard(meta.intro ?? (meta.title ? { title: meta.title, subtitle: meta.subtitle || '' } : null))
  : null;
const outroCard = captionsEnabled ? asCard(meta.outro) : null;
const CARD_FRAMES = Math.round(2.6 * FPS); // length of an intro/outro card
export const INTRO_FRAMES = introCard ? CARD_FRAMES : 0;
export const OUTRO_FRAMES = outroCard ? CARD_FRAMES : 0;

// The browser captured at this size; the composition matches it (see Root.tsx).
const VIDEO_W = 1280;
const VIDEO_H = 800;
// Scale the framed unit down so the gradient background shows as a margin.
const BASE_FIT = 0.86;

const msToFrames = (ms: number) => (ms / 1000) * FPS;

/** Output-frame length of a clip after its (possibly per-clip) speed-up. */
const clipOutputFrames = (clip: Clip) => Math.max(1, Math.round(msToFrames(clip.end - clip.start) / clipSpeed(clip)));

/** Total output frames the clip track occupies (no intro/outro). */
export const clipsTotalFrames = (cs: Clip[]) => cs.reduce((sum, c) => sum + clipOutputFrames(c), 0);

/** Full composition length: intro card + clips + outro card. Consumed by Root.tsx. */
export const totalDurationInFrames = (cs: Clip[]) => INTRO_FRAMES + clipsTotalFrames(cs) + OUTRO_FRAMES;

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
  const speed = clipSpeed(clip);

  const local = keyframes
    .filter((k) => k.time >= clip.start && k.time <= clip.end)
    .map((k) => ({
      frame: Math.max(0, Math.round(msToFrames(k.time - clip.start) / speed)),
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

// ---- Caption track --------------------------------------------------------
/** Fade 0 → 1 over the first `fade` frames and back to 0 over the last `fade` of `len`. */
const fadeEnvelope = (frame: number, len: number, fade = 10) =>
  interpolate(frame, [0, fade, Math.max(fade, len - fade), len], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

/** Lower-third subtitle pill, drawn over the whole frame (not the zoomed footage). */
const LowerThird: React.FC<{ text: string; durationInFrames: number }> = ({ text, durationInFrames }) => {
  const frame = useCurrentFrame();
  const opacity = fadeEnvelope(frame, durationInFrames, 9);
  const lift = interpolate(frame, [0, 12], [16, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 64 }}>
      <div
        style={{
          opacity,
          transform: `translateY(${lift}px)`,
          maxWidth: '76%',
          padding: '14px 28px',
          borderRadius: 14,
          background: 'rgba(10, 14, 32, 0.72)',
          backdropFilter: 'blur(8px)',
          border: '1px solid rgba(255, 255, 255, 0.10)',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.45)',
          color: '#eef1ff',
          fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif',
          fontSize: 30,
          fontWeight: 500,
          lineHeight: 1.25,
          textAlign: 'center',
          letterSpacing: 0.2,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

/** Full-screen intro / outro card with a title and subtitle. */
const TitleCard: React.FC<{ card: Card; durationInFrames: number }> = ({ card, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = fadeEnvelope(frame, durationInFrames, 14);
  const rise = spring({ frame, fps, config: { damping: 200, mass: 0.7 }, durationInFrames: 26 });
  const translateY = interpolate(rise, [0, 1], [22, 0]);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity }}>
      <div
        style={{
          transform: `translateY(${translateY}px)`,
          textAlign: 'center',
          color: '#ffffff',
          fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif',
          padding: '0 80px',
        }}
      >
        <div style={{ fontSize: 76, fontWeight: 700, letterSpacing: -1, lineHeight: 1.05 }}>{card.title}</div>
        {card.subtitle ? (
          <div style={{ marginTop: 22, fontSize: 34, fontWeight: 400, color: 'rgba(220, 226, 255, 0.82)' }}>
            {card.subtitle}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

// ---- Composition ----------------------------------------------------------
export const DemoVideo: React.FC = () => {
  // Cumulative output-frame offset for each clip Sequence, within the clip track.
  let cursor = 0;
  const placed = clips.map((clip) => {
    const from = cursor;
    const durationInFrames = clipOutputFrames(clip);
    cursor += durationInFrames;
    return { clip, from, durationInFrames };
  });
  const clipTrackFrames = cursor;

  return (
    <AbsoluteFill
      style={{
        // Dark navy → indigo gradient, suited to a SaaS product.
        background: 'linear-gradient(135deg, #0a0f24 0%, #131a3a 45%, #2a2065 100%)',
      }}
    >
      {introCard ? (
        <Sequence from={0} durationInFrames={INTRO_FRAMES}>
          <TitleCard card={introCard} durationInFrames={INTRO_FRAMES} />
        </Sequence>
      ) : null}

      {/* Footage + camera, shifted past the intro card. */}
      <Sequence from={INTRO_FRAMES} durationInFrames={Math.max(1, clipTrackFrames)}>
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ transform: `scale(${BASE_FIT})` }}>
            <BrowserFrame>
              {placed.map(({ clip, from, durationInFrames }, i) => (
                <Sequence key={i} from={from} durationInFrames={durationInFrames}>
                  <ClipCamera clip={clip}>
                    <OffthreadVideo
                      src={staticFile('raw.mp4')}
                      startFrom={Math.round(msToFrames(clip.start))}
                      playbackRate={clipSpeed(clip)}
                      muted
                      style={{ width: VIDEO_W, height: VIDEO_H, objectFit: 'cover' }}
                    />
                  </ClipCamera>
                </Sequence>
              ))}
            </BrowserFrame>
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* Lower-third captions, overlaid above the footage (so they aren't zoomed). */}
      {captionsEnabled
        ? placed.map(({ clip, from, durationInFrames }, i) => (
            <Sequence key={`cap-${i}`} from={INTRO_FRAMES + from} durationInFrames={durationInFrames}>
              <LowerThird text={clip.action} durationInFrames={durationInFrames} />
            </Sequence>
          ))
        : null}

      {outroCard ? (
        <Sequence from={INTRO_FRAMES + clipTrackFrames} durationInFrames={OUTRO_FRAMES}>
          <TitleCard card={outroCard} durationInFrames={OUTRO_FRAMES} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
