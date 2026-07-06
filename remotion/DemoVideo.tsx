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
export type Clip = { start: number; end: number; action: string; type: string; speed?: number; topCropPx?: number };
type Keyframe = { time: number; scale: number; x: number; y: number; action: string; type: string };
type Card = { title: string; subtitle: string };
type Meta = {
  title?: string;
  subtitle?: string;
  intro?: Card | null;
  outro?: Card | null;
  playbackSpeed?: number;
  captions?: boolean;
  loadingOverlay?: boolean;
  loadingOverlaySeconds?: number;
  topCropPx?: number;
};

const rawClips = clipsData as Clip[];
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
const viewport = ((browsePlan as { viewport?: { width?: number; height?: number } }).viewport ?? {}) as {
  width?: number;
  height?: number;
};
export const VIDEO_W = Number.isFinite(viewport.width) ? Number(viewport.width) : 1280;
export const VIDEO_H = Number.isFinite(viewport.height) ? Number(viewport.height) : 800;
const TOP_CROP_PX = Number.isFinite(meta.topCropPx) ? Math.max(0, Number(meta.topCropPx)) : 0;
const JOIN_GAP_MS = 120;

export const mergeContinuousClips = (cs: Clip[]): Clip[] => {
  const merged: Clip[] = [];
  for (const clip of cs) {
    const prev = merged[merged.length - 1];
    const gap = prev ? clip.start - prev.end : Infinity;
    const sameAction = prev && (prev.action || '') === (clip.action || '');
    const sameSpeed = prev && Math.abs(clipSpeed(prev) - clipSpeed(clip)) < 0.001;
    const sameCrop = prev && Number(prev.topCropPx ?? TOP_CROP_PX) === Number(clip.topCropPx ?? TOP_CROP_PX);
    if (prev && gap >= 0 && gap <= JOIN_GAP_MS && sameAction && sameSpeed && sameCrop) {
      prev.end = Math.max(prev.end, clip.end);
    } else {
      merged.push({ ...clip });
    }
  }
  return merged;
};

const clips = mergeContinuousClips(rawClips);
const loadingOverlayFrames =
  meta.loadingOverlay === true
    ? Math.round((Number.isFinite(meta.loadingOverlaySeconds) ? Number(meta.loadingOverlaySeconds) : 3) * FPS)
    : 0;

const TRANSITION_FRAMES = 0;

const msToFrames = (ms: number) => (ms / 1000) * FPS;

/** Output-frame length of a clip after its (possibly per-clip) speed-up. */
const clipOutputFrames = (clip: Clip) => Math.max(1, Math.round(msToFrames(clip.end - clip.start) / clipSpeed(clip)));

/**
 * Lay clips on the output timeline. Source-contiguous split clips are merged before this point,
 * so a manual split does not force a second video seek or introduce a visible seam.
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
    // Advance by the clip length. Transition overlap is disabled for source-contiguous flow.
    const fadeToNext = i < cs.length - 1 ? fadeBetween(dur[i], dur[i + 1]) : 0;
    cursor += dur[i] - fadeToNext;
  }
  const totalFrames = placed.length ? placed[placed.length - 1].from + placed[placed.length - 1].durationInFrames : 0;
  return { placed, totalFrames };
}

/** Full composition length: intro card + clip track + outro card. Consumed by Root.tsx. */
export const totalDurationInFrames = (cs: Clip[]) => INTRO_FRAMES + layoutClips(mergeContinuousClips(cs)).totalFrames + OUTRO_FRAMES;

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

const Corner: React.FC<{ x: 'left' | 'right'; y: 'top' | 'bottom'; opacity: number }> = ({ x, y, opacity }) => (
  <div
    style={{
      position: 'absolute',
      [x]: 30,
      [y]: 30,
      width: 28,
      height: 28,
      opacity,
      borderColor: 'rgba(255,255,255,0.42)',
      borderStyle: 'solid',
      borderTopWidth: y === 'top' ? 2 : 0,
      borderBottomWidth: y === 'bottom' ? 2 : 0,
      borderLeftWidth: x === 'left' ? 2 : 0,
      borderRightWidth: x === 'right' ? 2 : 0,
    }}
  />
);

const LoadingOverlay: React.FC<{ durationInFrames: number }> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const show = (at: number, len = 18) =>
    interpolate(frame, [at, at + len], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const exitStart = Math.max(1, durationInFrames - Math.round(0.75 * FPS));
  const y = interpolate(frame, [exitStart, durationInFrames - 1], [0, -VIDEO_H], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.ease),
  });
  const barScale = interpolate(frame, [12, 38], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const stripeHeight = interpolate(frame, [0, 28], [0, VIDEO_H], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        transform: `translateY(${y}px)`,
        background: '#0a1124',
        overflow: 'hidden',
        color: '#fff',
        fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif',
      }}
    >
      <div style={{ position: 'absolute', top: 0, right: 0, width: 84, height: 84, background: '#dc2626', opacity: show(0) }} />
      <div style={{ position: 'absolute', top: 0, left: 0, width: 6, height: stripeHeight, background: '#dc2626' }} />
      <Corner x="left" y="top" opacity={show(6)} />
      <Corner x="right" y="top" opacity={show(6)} />
      <Corner x="left" y="bottom" opacity={show(6)} />
      <Corner x="right" y="bottom" opacity={show(6)} />

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div
          style={{
            transform: `translateY(${interpolate(show(8), [0, 1], [16, 0])}px)`,
            opacity: show(8),
            color: '#f87171',
            fontSize: 18,
            fontWeight: 800,
            letterSpacing: '0.45em',
            textTransform: 'uppercase',
          }}
        >
          CHANNEL ISLANDS
        </div>
        <div
          style={{
            width: '86%',
            height: 4,
            marginTop: 26,
            background: '#dc2626',
            transform: `scaleX(${barScale})`,
            transformOrigin: 'left center',
          }}
        />
        <div
          style={{
            marginTop: 48,
            fontSize: 220,
            lineHeight: 0.82,
            fontWeight: 950,
            opacity: show(16),
            transform: `translateY(${interpolate(show(16), [0, 1], [42, 0])}px)`,
          }}
        >
          A&S
        </div>
        <div
          style={{
            marginTop: 36,
            color: '#dc2626',
            fontSize: 220,
            lineHeight: 0.82,
            fontWeight: 950,
            opacity: show(26),
            transform: `translateY(${interpolate(show(26), [0, 1], [42, 0])}px)`,
          }}
        >
          TAXIS
        </div>
      </AbsoluteFill>

      <div
        style={{
          position: 'absolute',
          left: 84,
          right: 84,
          bottom: 54,
          opacity: show(42),
          borderTop: '1px solid rgba(255,255,255,0.68)',
          paddingTop: 22,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          color: 'rgba(255,255,255,0.78)',
          fontSize: 22,
          fontWeight: 800,
          letterSpacing: '0.18em',
        }}
      >
        <div>GUERNSEY</div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <span>LOADING</span>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: 10,
                height: 10,
                background: '#dc2626',
                opacity: 0.35 + 0.65 * ((Math.sin(frame / 8 - i) + 1) / 2),
              }}
            />
          ))}
        </div>
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

      {/* Full-bleed footage. Source-contiguous splits are coalesced so playback stays seamless. */}
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

      {loadingOverlayFrames > 0 ? (
        <Sequence from={0} durationInFrames={loadingOverlayFrames}>
          <LoadingOverlay durationInFrames={loadingOverlayFrames} />
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
  const topCropPx = Number.isFinite(clip.topCropPx) ? Math.max(0, Number(clip.topCropPx)) : TOP_CROP_PX;
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
          style={{
            width: VIDEO_W,
            height: VIDEO_H + topCropPx,
            objectFit: 'cover',
            transform: topCropPx ? `translateY(-${topCropPx}px)` : undefined,
          }}
        />
      </ClipCamera>
    </AbsoluteFill>
  );
};
