import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Freeze,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { Clip, DemoVideoProps, Keyframe, PlanMeta, TitleCard as Card } from '@wdv/schema';
import { resolveOverlay } from '@wdv/schema';
import { clipSpeed as sharedClipSpeed, layoutClips, mergeContinuousClips, type LayoutOptions } from '@wdv/timeline';
import { resolveOverlayComponent } from '../shared/overlays/registry';

/**
 * Walkthrough composition: full-bleed recorded footage cut into sped-up clips, with
 * spring camera zoom, lower-third captions, intro/outro cards and an optional brand
 * overlay opening. Entirely props-driven — the Player and the renderer feed it the
 * same DemoVideoProps.
 */

export const FPS = 60;
const CARD_SECONDS = 2.6;
const TRANSITION_FRAMES = 0;

const asCard = (c?: Card | null): Card | null =>
  c && (c.title || c.subtitle) ? { title: c.title || '', subtitle: c.subtitle || '' } : null;

/** Everything the layout/render math needs, derived once from props. */
export interface ResolvedDemoVideo {
  clips: Clip[];
  layoutOpts: LayoutOptions;
  introCard: Card | null;
  outroCard: Card | null;
  introFrames: number;
  outroFrames: number;
  overlayFrames: number;
  /** Freeze-frame hold on the closing shot (meta.finalHoldSeconds), matching the fast path's tpad. */
  finalHoldFrames: number;
  captionsEnabled: boolean;
  topCropPx: number;
  totalFrames: number;
  durationInFrames: number;
}

export function resolveDemoVideo(props: DemoVideoProps): ResolvedDemoVideo {
  const meta: PlanMeta = props.meta ?? {};
  const defaultSpeed = Number.isFinite(meta.playbackSpeed) ? (meta.playbackSpeed as number) : 4;
  const topCropPx = Number.isFinite(meta.topCropPx) ? Math.max(0, Number(meta.topCropPx)) : 0;
  const layoutOpts: LayoutOptions = {
    fps: FPS,
    defaultSpeed,
    defaultTopCropPx: topCropPx,
    transitionFrames: TRANSITION_FRAMES,
  };

  const captionsEnabled = meta.captions !== false;
  const introCard = captionsEnabled
    ? asCard(meta.intro ?? (meta.title ? { title: meta.title, subtitle: meta.subtitle || '' } : null))
    : null;
  const outroCard = captionsEnabled ? asCard(meta.outro) : null;
  const cardFrames = Math.round(CARD_SECONDS * FPS);
  const introFrames = introCard ? cardFrames : 0;
  const outroFrames = outroCard ? cardFrames : 0;

  const overlay = resolveOverlay(meta);
  const overlayFrames = overlay ? Math.round(overlay.seconds * FPS) : 0;

  const clips = mergeContinuousClips(props.clips, layoutOpts);
  const { totalFrames } = layoutClips(clips, layoutOpts);

  const finalHoldSeconds = Number(meta.finalHoldSeconds);
  const finalHoldFrames =
    clips.length > 0 && Number.isFinite(finalHoldSeconds) && finalHoldSeconds > 0
      ? Math.round(finalHoldSeconds * FPS)
      : 0;

  return {
    clips,
    layoutOpts,
    introCard,
    outroCard,
    introFrames,
    outroFrames,
    overlayFrames,
    finalHoldFrames,
    captionsEnabled,
    topCropPx,
    totalFrames,
    // Fall back to a short placeholder length so the studio opens before the first recording.
    durationInFrames: Math.max(introFrames + totalFrames + finalHoldFrames + outroFrames, 60),
  };
}

/** Composition metadata for calculateMetadata / selectComposition. */
export function demoVideoMetadata(props: DemoVideoProps): { durationInFrames: number; width: number; height: number; fps: number } {
  const resolved = resolveDemoVideo(props);
  return {
    durationInFrames: resolved.durationInFrames,
    width: props.viewport.width,
    height: props.viewport.height,
    fps: FPS,
  };
}

const msToFrames = (ms: number) => (ms / 1000) * FPS;

/** http(s) URLs pass straight through (Player); bare names resolve against publicDir (renderer). */
const resolveVideoSrc = (videoSrc: string) => (/^https?:\/\//.test(videoSrc) || videoSrc.startsWith('/') ? videoSrc : staticFile(videoSrc));

// ---- Camera (zoom) --------------------------------------------------------
const ClipCamera: React.FC<{
  clip: Clip;
  keyframes: Keyframe[];
  layoutOpts: LayoutOptions;
  viewport: DemoVideoProps['viewport'];
  children: React.ReactNode;
}> = ({ clip, keyframes, layoutOpts, viewport, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const speed = sharedClipSpeed(clip, layoutOpts.defaultSpeed);

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
  let originX = viewport.width / 2;
  let originY = viewport.height / 2;

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
    originX = interpolate(frame, frames, local.map((k) => k.x), { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    originY = interpolate(frame, frames, local.map((k) => k.y), { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
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
const fadeEnvelope = (frame: number, len: number, fade = 10) =>
  interpolate(frame, [0, fade, Math.max(fade, len - fade), len], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

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

const TitleCardScene: React.FC<{ card: Card; durationInFrames: number }> = ({ card, durationInFrames }) => {
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

// ---- Footage --------------------------------------------------------------
const ClipFootage: React.FC<{
  clip: Clip;
  durationInFrames: number;
  fadeIn: number;
  fadeOut: number;
  props: DemoVideoProps;
  layoutOpts: LayoutOptions;
  defaultTopCropPx: number;
}> = ({ clip, durationInFrames, fadeIn, fadeOut, props, layoutOpts, defaultTopCropPx }) => {
  const frame = useCurrentFrame();
  const topCropPx = Number.isFinite(clip.topCropPx) ? Math.max(0, Number(clip.topCropPx)) : defaultTopCropPx;
  const fadeInOpacity = fadeIn > 0 ? interpolate(frame, [0, fadeIn], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.ease) }) : 1;
  const fadeOutOpacity = fadeOut > 0 ? interpolate(frame, [durationInFrames - fadeOut, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.ease) }) : 1;
  const opacity = Math.min(fadeInOpacity, fadeOutOpacity);

  return (
    <AbsoluteFill style={{ opacity }}>
      <ClipCamera clip={clip} keyframes={props.keyframes} layoutOpts={layoutOpts} viewport={props.viewport}>
        <OffthreadVideo
          src={resolveVideoSrc(props.videoSrc)}
          startFrom={Math.round(msToFrames(clip.start))}
          playbackRate={sharedClipSpeed(clip, layoutOpts.defaultSpeed)}
          muted
          style={{
            width: props.viewport.width,
            height: props.viewport.height + topCropPx,
            objectFit: 'cover',
            transform: topCropPx ? `translateY(-${topCropPx}px)` : undefined,
          }}
        />
      </ClipCamera>
    </AbsoluteFill>
  );
};

// ---- Composition ----------------------------------------------------------
export const DemoVideo: React.FC<DemoVideoProps> = (props) => {
  const resolved = resolveDemoVideo(props);
  const { placed } = layoutClips(resolved.clips, resolved.layoutOpts);
  const overlay = resolveOverlay(props.meta ?? {});
  const OverlayComponent = overlay ? resolveOverlayComponent(overlay.id) : null;

  return (
    <AbsoluteFill style={{ background: '#05070f' }}>
      {resolved.introCard ? (
        <Sequence from={0} durationInFrames={resolved.introFrames}>
          <TitleCardScene card={resolved.introCard} durationInFrames={resolved.introFrames} />
        </Sequence>
      ) : null}

      {/* Full-bleed footage. Source-contiguous splits are coalesced so playback stays seamless. */}
      {placed.map(({ clip, from, durationInFrames, fadeIn, fadeOut }, i) => (
        <Sequence key={i} from={resolved.introFrames + from} durationInFrames={durationInFrames}>
          <ClipFootage
            clip={clip}
            durationInFrames={durationInFrames}
            fadeIn={fadeIn}
            fadeOut={fadeOut}
            props={props}
            layoutOpts={resolved.layoutOpts}
            defaultTopCropPx={resolved.topCropPx}
          />
        </Sequence>
      ))}

      {/* Lower-third captions, overlaid above the footage. */}
      {resolved.captionsEnabled
        ? placed.map(({ clip, from, durationInFrames }, i) => {
            // End where the next clip begins so consecutive captions don't overlap.
            const capDuration = i < placed.length - 1 ? placed[i + 1].from - from : durationInFrames;
            return (
              <Sequence key={`cap-${i}`} from={resolved.introFrames + from} durationInFrames={Math.max(1, capDuration)}>
                <LowerThird text={clip.action} durationInFrames={Math.max(1, capDuration)} />
              </Sequence>
            );
          })
        : null}

      {/* Freeze-frame hold on the closing shot, mirroring the fast path's tpad clone. */}
      {resolved.finalHoldFrames > 0 && placed.length > 0
        ? (() => {
            const last = placed[placed.length - 1];
            return (
              <Sequence
                from={resolved.introFrames + resolved.totalFrames}
                durationInFrames={resolved.finalHoldFrames}
              >
                <Freeze frame={last.durationInFrames - 1}>
                  <ClipFootage
                    clip={last.clip}
                    durationInFrames={last.durationInFrames}
                    fadeIn={0}
                    fadeOut={0}
                    props={props}
                    layoutOpts={resolved.layoutOpts}
                    defaultTopCropPx={resolved.topCropPx}
                  />
                </Freeze>
              </Sequence>
            );
          })()
        : null}

      {resolved.outroCard ? (
        <Sequence
          from={resolved.introFrames + resolved.totalFrames + resolved.finalHoldFrames}
          durationInFrames={resolved.outroFrames}
        >
          <TitleCardScene card={resolved.outroCard} durationInFrames={resolved.outroFrames} />
        </Sequence>
      ) : null}

      {OverlayComponent && resolved.overlayFrames > 0 ? (
        <Sequence from={0} durationInFrames={resolved.overlayFrames}>
          <OverlayComponent durationInFrames={resolved.overlayFrames} props={overlay!.props} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
