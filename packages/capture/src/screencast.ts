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
  stop: () => Promise<void>;
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
  let lastBuffer: Buffer | null = null;
  let lastAt = -Infinity; // wall-clock ms of the last frame we recorded (for cadence bookkeeping)
  let timer: ReturnType<typeof setInterval> | null = null;

  // Record a frame, deduping static holds. Always advance `lastAt` (even on a dropped duplicate)
  // so the timer doesn't hot-loop force-capturing an unchanging page.
  const record = (buffer: Buffer, now: number) => {
    lastAt = now;
    if (lastBuffer && buffer.equals(lastBuffer)) return;
    frames.push({ buffer, t: now - t0Ref.t });
    lastBuffer = buffer;
  };

  cdp.on('Page.screencastFrame', (frame) => {
    // Ack first (fire-and-forget) so Chrome can paint the next frame without waiting on our decode.
    cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    if (!stopped) record(Buffer.from(frame.data, 'base64'), Date.now());
  });

  t0Ref.t = Date.now();
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  });

  // Cadence floor: if the screencast hasn't delivered within one interval, grab a screenshot
  // ourselves. Clipped to the exact viewport at scale 1 so these frames match the screencast's
  // dimensions (mixed sizes would break the single-resolution concat encode).
  timer = setInterval(() => {
    const now = Date.now();
    if (stopped || now - lastAt < intervalMs) return;
    cdp
      .send('Page.captureScreenshot', {
        format: 'jpeg',
        quality,
        clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 },
      })
      .then((shot: { data: string }) => {
        if (!stopped) record(Buffer.from(shot.data, 'base64'), Date.now());
      })
      .catch(() => {
        /* session busy or ended — the next tick retries */
      });
  }, intervalMs);
  timer.unref?.();

  return {
    frames,
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

/**
 * Encode captured frames to an MP4 that preserves real-time pacing, using the ffmpeg concat
 * demuxer with per-frame durations derived from arrival offsets — so the video's timeline
 * matches moments.json (later consumed by the trim stage).
 */
export function encodeFrames(input: CapturedFrame[], outPath: string): void {
  if (input.length === 0) throw new Error('No frames were captured — recording is empty.');

  // Frames arrive from two async sources (the screencast event stream and the cadence timer's
  // screenshots), so their arrival offsets can interleave slightly out of order. Sort by time so
  // the per-frame durations below are always non-negative.
  const frames = [...input].sort((a, b) => a.t - b.t);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-frames-'));
  try {
    const lines: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const file = path.join(tmpDir, `frame-${String(i).padStart(5, '0')}.jpg`);
      fs.writeFileSync(file, frames[i].buffer);
      // Duration until the next frame (clamped); last frame held for 1s.
      const next = i < frames.length - 1 ? frames[i + 1].t : frames[i].t + 1000;
      const dur = Math.max(0.016, (next - frames[i].t) / 1000);
      lines.push(`file '${file}'`);
      lines.push(`duration ${dur.toFixed(3)}`);
    }
    // The concat demuxer needs the final file repeated for its duration to apply.
    lines.push(`file '${path.join(tmpDir, `frame-${String(frames.length - 1).padStart(5, '0')}.jpg`)}'`);

    const listFile = path.join(tmpDir, 'frames.txt');
    fs.writeFileSync(listFile, lines.join('\n'));

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const res = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-vsync', 'vfr',
        // Screencast frames can come back with an odd height (e.g. 1280x713); libx264 + yuv420p
        // require even dimensions, so round both down to the nearest even number.
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
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
