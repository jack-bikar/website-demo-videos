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

// The footage fills the whole frame (the website always takes the entire screen).
const VIDEO_W = 1280;
const VIDEO_H = 800;

// Crossfade length between consecutive clips, and the opening/closing fade from/to black.
// Long and even so scene changes feel slow and smooth rather than hard cuts.
const TRANSITION_FRAMES = Math.round(0.6 * FPS); // ~0.6s dissolve

const msToFrames = (ms: number) => (ms / 1000) * FPS;

/** Output-frame length of a clip after its (possibly per-clip) speed-up. */
const clipOutputFrames = (clip: Clip) => Math.max(1, Math.round(msToFrames(clip.end - clip.start) / clipSpeed(clip)));

/**
 * Lay clips on the output timeline with overlapping crossfades. Each clip starts while the
 * previous one is still on screen and fades in over the overlap, so scenes dissolve into one
 * another. The crossfade is clamped to a fraction of the shorter neighbour so short clips don't
 * fully overlap. Returns absolute `from`/`durationInFrames` plus the fade lengths to apply.
 */
type Placed = { clip: Clip; from: number; durationInFrames: number; fadeIn: number; fadeOut: number };
export function layoutClips(cs: Clip[]): { placed: Placed[]; totalFrames: number } {
  const dur = cs.map(clipOutputFrames);
  const fadeBetween = (a: number, b: number) => Math.min(TRANSITION_FRAMES, Math.floor(Math.min(a, b) * 0.4));

  const placed: Placed[] = [];
  let cursor = 0;
  for (let i = 0; i < cs.length; i++) {
    const fadeIn = i === 0 ? Math.min(TRANSITION_FRAMES, Math.floor(dur[i] * 0.4)) : fadeBetween(dur[i - 1], dur[i]);
    const fadeOut = i === cs.length - 1 ? Math.min(TRANSITION_FRAMES, Math.floor(dur[i] * 0.4)) : 0;
    placed.push({ clip: cs[i], from: cursor, durationInFrames: dur[i], fadeIn, fadeOut });
    // Advance so the next clip overlaps this one by their shared crossfade.
    const fadeToNext = i < cs.length - 1 ? fadeBetween(dur[i], dur[i + 1]) : 0;
    cursor += dur[i] - fadeToNext;
  }
  const totalFrames = placed.length ? placed[placed.length - 1].from + placed[placed.length - 1].durationInFrames : 0;
  return { placed, totalFrames };
}

/** Full composition length: intro card + crossfaded clip track + outro card. Consumed by Root.tsx. */
export const totalDurationInFrames = (cs: Clip[]) => INTRO_FRAMES + layoutClips(cs).totalFrames + OUTRO_FRAMES;

// ---- Camera (zoom) --------------------------------------------------------
/**
 * Drives a smooth zoom for a single clip when keyframes exist (zoom is opt-out via
 * `meta.zoom: false`, which makes keyframes.json empty — then this is a steady, un-zoomed shot).
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

  const settle = spring({ frame, fps, config: { damping: 200, mass: 0.6 }, durationInFrames: 18 });
  const easedScale = 1 + (scale - 1) * settle;

  return (
    <AbsoluteFill style={{ transform: `scale(${easedScale})`, transformOrigin: `${originX}px ${originY}px` }}>
      {children}
    </AbsoluteFill>
  );
};

// ---- Caption track --------------------------------------------------------
/** Fade 0 → 1 over the first `fade` frames and back to 0 over the last `fade` of `len`. */
const fadeEnvelope = (frame: number, len: number, fade = 10) =>
  interpolate(frame, [0, fade, Math.max(fade, len - fade), len], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

/** Lower-third subtitle pill, drawn over the footage. */
const LowerThird: React.FC<{ text: string; durationInFrames: number }> = ({ text, durationInFrames }) => {
  const frame = useCurrentFrame();
  const opacity = fadeEnvelope(frame, durationInFrames, 14);
  const lift = interpolate(frame, [0, 16], [16, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 56 }}>
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

/** Full-screen intro / outro card with a title and subtitle (only when meta provides one). */
const TitleCard: React.FC<{ card: Card; durationInFrames: number }> = ({ card, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = fadeEnvelope(frame, durationInFrames, 16);
  const rise = spring({ frame, fps, config: { damping: 200, mass: 0.7 }, durationInFrames: 26 });
  const translateY = interpolate(rise, [0, 1], [22, 0]);
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        opacity,
        background: 'linear-gradient(135deg, #0a0f24 0%, #131a3a 45%, #2a2065 100%)',
      }}
    >
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
  const { placed, totalFrames } = layoutClips(clips);

  return (
    <AbsoluteFill style={{ background: '#05070f' }}>
      {introCard ? (
        <Sequence from={0} durationInFrames={INTRO_FRAMES}>
          <TitleCard card={introCard} durationInFrames={INTRO_FRAMES} />
        </Sequence>
      ) : null}

      {/* Full-bleed footage. Clips overlap and fade so scenes dissolve into one another. */}
      {placed.map(({ clip, from, durationInFrames, fadeIn, fadeOut }, i) => (
        <Sequence key={i} from={INTRO_FRAMES + from} durationInFrames={durationInFrames}>
          <ClipFootage clip={clip} durationInFrames={durationInFrames} fadeIn={fadeIn} fadeOut={fadeOut} />
        </Sequence>
      ))}

      {/* Lower-third captions, overlaid above the footage. */}
      {captionsEnabled
        ? placed.map(({ clip, from, durationInFrames }, i) => {
            // End where the next clip begins so consecutive captions don't overlap.
            const capDuration = i < placed.length - 1 ? placed[i + 1].from - from : durationInFrames;
            return (
              <Sequence key={`cap-${i}`} from={INTRO_FRAMES + from} durationInFrames={Math.max(1, capDuration)}>
                <LowerThird text={clip.action} durationInFrames={Math.max(1, capDuration)} />
              </Sequence>
            );
          })
        : null}

      {outroCard ? (
        <Sequence from={INTRO_FRAMES + totalFrames} durationInFrames={OUTRO_FRAMES}>
          <TitleCard card={outroCard} durationInFrames={OUTRO_FRAMES} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};

/** One clip of footage filling the screen, with crossfade in/out opacity. */
const ClipFootage: React.FC<{ clip: Clip; durationInFrames: number; fadeIn: number; fadeOut: number }> = ({
  clip,
  durationInFrames,
  fadeIn,
  fadeOut,
}) => {
  const frame = useCurrentFrame();
  const fadeInOpacity = fadeIn > 0 ? interpolate(frame, [0, fadeIn], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.ease) }) : 1;
  const fadeOutOpacity = fadeOut > 0 ? interpolate(frame, [durationInFrames - fadeOut, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.ease) }) : 1;
  const opacity = Math.min(fadeInOpacity, fadeOutOpacity);

  return (
    <AbsoluteFill style={{ opacity }}>
      <ClipCamera clip={clip}>
        <OffthreadVideo
          src={staticFile('raw.mp4')}
          startFrom={Math.round(msToFrames(clip.start))}
          playbackRate={clipSpeed(clip)}
          muted
          style={{ width: VIDEO_W, height: VIDEO_H, objectFit: 'cover' }}
        />
      </ClipCamera>
    </AbsoluteFill>
  );
};
