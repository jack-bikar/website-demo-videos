import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { z } from 'zod';

/**
 * Generic brand "loading" intro: accent blocks, corner ticks, kicker line, stacked title,
 * footer strip with pulsing loader dots, then a slide-up exit into the footage.
 * Extracted from the client-specific LoadingOverlay that used to be hardcoded in
 * DemoVideo.tsx; defaults preserve that original look for legacy plans.
 */

export const brandIntroPropsSchema = z
  .object({
    kicker: z.string().default('CHANNEL ISLANDS'),
    /** Stacked headline lines; every second line takes the accent color. */
    titleLines: z.array(z.string()).min(1).default(['A&S', 'TAXIS']),
    footerLeft: z.string().default('GUERNSEY'),
    footerRight: z.string().default('LOADING'),
    accentColor: z.string().default('#dc2626'),
    background: z.string().default('#0a1124'),
    kickerColor: z.string().default('#f87171'),
  })
  .strict();
export type BrandIntroProps = z.infer<typeof brandIntroPropsSchema>;

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

export const BrandIntroOverlay: React.FC<{ durationInFrames: number; props?: Partial<BrandIntroProps> }> = ({
  durationInFrames,
  props,
}) => {
  const frame = useCurrentFrame();
  const { fps, height: videoH } = useVideoConfig();
  const p = brandIntroPropsSchema.parse(props ?? {});

  const show = (at: number, len = 18) =>
    interpolate(frame, [at, at + len], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const exitStart = Math.max(1, durationInFrames - Math.round(0.75 * fps));
  const y = interpolate(frame, [exitStart, durationInFrames - 1], [0, -videoH], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.ease),
  });
  const barScale = interpolate(frame, [12, 38], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const stripeHeight = interpolate(frame, [0, 28], [0, videoH], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        transform: `translateY(${y}px)`,
        background: p.background,
        overflow: 'hidden',
        color: '#fff',
        fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif',
      }}
    >
      <div style={{ position: 'absolute', top: 0, right: 0, width: 84, height: 84, background: p.accentColor, opacity: show(0) }} />
      <div style={{ position: 'absolute', top: 0, left: 0, width: 6, height: stripeHeight, background: p.accentColor }} />
      <Corner x="left" y="top" opacity={show(6)} />
      <Corner x="right" y="top" opacity={show(6)} />
      <Corner x="left" y="bottom" opacity={show(6)} />
      <Corner x="right" y="bottom" opacity={show(6)} />

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div
          style={{
            transform: `translateY(${interpolate(show(8), [0, 1], [16, 0])}px)`,
            opacity: show(8),
            color: p.kickerColor,
            fontSize: 18,
            fontWeight: 800,
            letterSpacing: '0.45em',
            textTransform: 'uppercase',
          }}
        >
          {p.kicker}
        </div>
        <div
          style={{
            width: '86%',
            height: 4,
            marginTop: 26,
            background: p.accentColor,
            transform: `scaleX(${barScale})`,
            transformOrigin: 'left center',
          }}
        />
        {p.titleLines.map((line, i) => (
          <div
            key={i}
            style={{
              marginTop: i === 0 ? 48 : 36,
              color: i % 2 === 1 ? p.accentColor : '#ffffff',
              fontSize: 220,
              lineHeight: 0.82,
              fontWeight: 950,
              opacity: show(16 + i * 10),
              transform: `translateY(${interpolate(show(16 + i * 10), [0, 1], [42, 0])}px)`,
            }}
          >
            {line}
          </div>
        ))}
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
        <div>{p.footerLeft}</div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <span>{p.footerRight}</span>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: 10,
                height: 10,
                background: p.accentColor,
                opacity: 0.35 + 0.65 * ((Math.sin(frame / 8 - i) + 1) / 2),
              }}
            />
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
