import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Page } from 'puppeteer-core';
import type { Viewport } from '@wdv/schema';
import { DEFAULT_CAPTURE_FPS, DEFAULT_SCREENCAST_QUALITY } from './connect';

/** Mutable epoch shared between the screencast and step execution so all timestamps are
 *  video-relative. `t` is (re)set the moment the screencast starts. */
export interface EpochRef {
  t: number;
}

export interface CapturedFrame {
  buffer: Buffer;
  /** ms offset from the screencast epoch. */
  t: number;
}

export interface Screencast {
  frames: CapturedFrame[];
  captureViewportFrameAt: (t: number) => Promise<boolean>;
  setLiveCaptureEnabled: (enabled: boolean) => void;
  setScreenshotOnlyMode: (enabled: boolean) => void;
  stop: () => Promise<void>;
}

export interface EncodeFrameOptions {
  /** Constant output framerate for the raw capture. */
  fps?: number;
  /** Hold the final captured frame for this long so final moments can clamp cleanly. */
  tailMs?: number;
}

/**
 * Starts a CDP screencast and collects JPEG frames in memory with their arrival offsets.
 * Steel's native session recording is RRWeb events, not an MP4 — screencasting is how we get
 * actual video frames out of a cloud session.
 *
 * Screencast alone is event-driven: Chrome only emits a frame when it repaints, and throttles to
 * ~25fps during fast scrolls, so motion steps and the video reads as choppy. To get a screen-
 * recorder-style constant framerate we combine two sources:
 *   1. the screencast stream — cheap, high-throughput, delivers frames as fast as Chrome paints;
 *      we ack each frame immediately (before decoding) so Chrome never waits on us to composite
 *      the next one, which lifts the natural rate.
 *   2. a fixed-cadence timer — a floor that force-captures a screenshot whenever the screencast
 *      falls behind `captureFps`, guaranteeing a steady frame spacing through throttled scrolls.
 * Byte-identical consecutive frames are dropped (Chrome's JPEG encoder is deterministic, so a
 * static hold yields the same bytes) — that keeps the cadence during motion without exploding a
 * multi-second hold into hundreds of duplicate frames.
 */
export async function startScreencast(
  page: Page,
  viewport: Viewport,
  t0Ref: EpochRef,
  options: { quality?: number; captureFps?: number } = {},
): Promise<Screencast> {
  const cdp = await page.createCDPSession();
  const frames: CapturedFrame[] = [];
  const quality = Number.isFinite(options.quality as number)
    ? Math.max(1, Math.min(100, Math.round(options.quality as number)))
    : DEFAULT_SCREENCAST_QUALITY;
  const captureFps = Number.isFinite(options.captureFps as number)
    ? Math.max(10, Math.min(60, Math.round(options.captureFps as number)))
    : DEFAULT_CAPTURE_FPS;
  const intervalMs = Math.round(1000 / captureFps);

  let stopped = false;
  let liveCaptureEnabled = true;
  let screencastFramesEnabled = true;
  let fallbackInFlight = false;
  let lastBuffer: Buffer | null = null;
  let lastAt = -Infinity; // wall-clock ms of the last frame we recorded (for cadence bookkeeping)
  let timer: ReturnType<typeof setInterval> | null = null;

  // Record a frame, deduping static holds. Always advance `lastAt` (even on a dropped duplicate)
  // so the timer doesn't hot-loop force-capturing an unchanging page.
  const recordAt = (buffer: Buffer, t: number): boolean => {
    lastAt = Date.now();
    if (lastBuffer && buffer.equals(lastBuffer)) return false;
    frames.push({ buffer, t });
    lastBuffer = buffer;
    return true;
  };

  const record = (buffer: Buffer, now: number) => {
    lastAt = now;
    if (lastBuffer && buffer.equals(lastBuffer)) return;
    frames.push({ buffer, t: now - t0Ref.t });
    lastBuffer = buffer;
  };

  cdp.on('Page.screencastFrame', (frame) => {
    // Ack first (fire-and-forget) so Chrome can paint the next frame without waiting on our decode.
    cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    if (!stopped && liveCaptureEnabled && screencastFramesEnabled) record(Buffer.from(frame.data, 'base64'), Date.now());
  });

  t0Ref.t = Date.now();
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  });

  // Cadence floor: if the screencast hasn't delivered within one interval, grab a viewport
  // screenshot ourselves. Continuous scrolls can force this into screenshot-only mode because CDP
  // screencast frames may include the page's scroll offset instead of the visible viewport.
  timer = setInterval(() => {
    const now = Date.now();
    if (stopped || !liveCaptureEnabled || fallbackInFlight || now - lastAt < intervalMs) return;
    fallbackInFlight = true;
    cdp
      .send('Page.captureScreenshot', {
        format: 'jpeg',
        quality,
        fromSurface: true,
        captureBeyondViewport: false,
      })
      .then((shot: { data: string }) => {
        const shotAt = Date.now();
        if (stopped) return;
        const buffer = Buffer.from(shot.data, 'base64');
        // During long compositor-driven scrolls Chrome can transiently return just the body
        // background from captureScreenshot. Keep the last real frame instead of encoding that.
        if (frames.length > 0 && isLikelyBlankFallbackFrame(buffer, viewport)) {
          lastAt = shotAt;
          return;
        }
        record(buffer, shotAt);
      })
      .catch(() => {
        /* session busy or ended — the next tick retries */
      })
      .finally(() => {
        fallbackInFlight = false;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    frames,
    captureViewportFrameAt: async (t) => {
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality,
        fromSurface: true,
        captureBeyondViewport: false,
      });
      if (stopped) return false;
      const buffer = Buffer.from((shot as { data: string }).data, 'base64');
      if (frames.length > 0 && isLikelyBlankFallbackFrame(buffer, viewport)) {
        lastAt = Date.now();
        return false;
      }
      return recordAt(buffer, Math.max(0, Math.round(t)));
    },
    setLiveCaptureEnabled: (enabled) => {
      liveCaptureEnabled = enabled;
      lastAt = enabled ? Date.now() - intervalMs : Date.now();
    },
    setScreenshotOnlyMode: (enabled) => {
      screencastFramesEnabled = !enabled;
      if (enabled) lastAt = Date.now() - intervalMs;
    },
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      try {
        await cdp.send('Page.stopScreencast');
      } catch (_e) {
        /* ignore */
      }
    },
  };
}

const clampEncodeFps = (fps: number | undefined): number => {
  const value = Number.isFinite(fps) ? Math.round(fps as number) : DEFAULT_CAPTURE_FPS;
  return Math.max(10, Math.min(60, value));
};

const frameName = (index: number, prefix = 'frame') => `${prefix}-${String(index).padStart(6, '0')}.jpg`;

export function isLikelyBlankFallbackFrame(buffer: Buffer, viewport: Pick<Viewport, 'width' | 'height'>): boolean {
  const pixels = Math.max(1, viewport.width * viewport.height);
  const minUsefulBytes = Math.max(12_000, Math.round(pixels * 0.02));
  return buffer.length < minUsefulBytes;
}

function linkOrCopy(source: string, target: string): void {
  try {
    fs.linkSync(source, target);
  } catch (_e) {
    fs.copyFileSync(source, target);
  }
}

/**
 * Encode captured frames to a constant-cadence MP4 that preserves real-time pacing.
 *
 * The old concat-demuxer/VFR path wrote per-frame durations, but ffmpeg still treated the image
 * input as a 25fps stream and silently dropped sub-40ms cadence frames. Here we first materialize a
 * CFR image sequence at the requested capture FPS, reusing each latest captured frame until a newer
 * timestamp is due. Repeated frames are hardlinked, so long static holds remain cheap on disk while
 * the resulting MP4 behaves like a real screen recording.
 */
export function encodeFrames(input: CapturedFrame[], outPath: string, options: EncodeFrameOptions = {}): void {
  if (input.length === 0) throw new Error('No frames were captured — recording is empty.');

  // Frames arrive from two async sources (the screencast event stream and the cadence timer's
  // screenshots), so their arrival offsets can interleave slightly out of order. Sort by time so
  // the sequence below is always monotonic.
  const frames = [...input].sort((a, b) => a.t - b.t);
  const fps = clampEncodeFps(options.fps);
  const intervalMs = 1000 / fps;
  const tailMs = Number.isFinite(options.tailMs) ? Math.max(0, options.tailMs as number) : 1000;
  const durationMs = Math.max(intervalMs, Math.max(0, frames[frames.length - 1].t) + tailMs);
  const outputFrameCount = Math.max(1, Math.ceil(durationMs / intervalMs) + 1);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-frames-'));
  try {
    for (let i = 0; i < frames.length; i++) {
      const file = path.join(tmpDir, frameName(i, 'source'));
      fs.writeFileSync(file, frames[i].buffer);
    }

    let sourceIndex = 0;
    for (let i = 0; i < outputFrameCount; i++) {
      const t = i * intervalMs;
      while (sourceIndex < frames.length - 1 && frames[sourceIndex + 1].t <= t + 0.5) {
        sourceIndex++;
      }
      const source = path.join(tmpDir, frameName(sourceIndex, 'source'));
      const target = path.join(tmpDir, frameName(i));
      linkOrCopy(source, target);
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const res = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostats',
        '-loglevel', 'warning',
        '-y',
        '-framerate', String(fps),
        '-start_number', '0',
        '-i', path.join(tmpDir, 'frame-%06d.jpg'),
        // Screencast frames can come back with an odd height (e.g. 1280x713); libx264 + yuv420p
        // require even dimensions, so round both down to the nearest even number.
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-r', String(fps),
        '-fps_mode', 'cfr',
        '-an',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-movflags', '+faststart',
        outPath,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (res.status !== 0) {
      throw new Error(`ffmpeg exited with code ${res.status}. Is ffmpeg installed and on PATH?`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
