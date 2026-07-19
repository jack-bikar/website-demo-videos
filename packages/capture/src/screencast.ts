import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Page } from 'puppeteer-core';
import type { Viewport } from '@wdv/schema';
import { DEFAULT_SCREENCAST_QUALITY } from './connect';

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
 */
export async function startScreencast(
  page: Page,
  viewport: Viewport,
  t0Ref: EpochRef,
  options: { quality?: number } = {},
): Promise<Screencast> {
  const cdp = await page.createCDPSession();
  const frames: CapturedFrame[] = [];
  const quality = Number.isFinite(options.quality as number)
    ? Math.max(1, Math.min(100, Math.round(options.quality as number)))
    : DEFAULT_SCREENCAST_QUALITY;

  cdp.on('Page.screencastFrame', async (frame) => {
    frames.push({ buffer: Buffer.from(frame.data, 'base64'), t: Date.now() - t0Ref.t });
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
    } catch (_e) {
      /* session may have ended; ignore */
    }
  });

  t0Ref.t = Date.now();
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  });

  return {
    frames,
    stop: async () => {
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
export function encodeFrames(frames: CapturedFrame[], outPath: string): void {
  if (frames.length === 0) throw new Error('No frames were captured — recording is empty.');

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
