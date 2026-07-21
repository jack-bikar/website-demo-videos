import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { encodeFrames, type CapturedFrame } from '../src/screencast';

const hasTool = (tool: string) => spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0;
const itWithFfmpeg = hasTool('ffmpeg') && hasTool('ffprobe') ? it : it.skip;

function makeJpeg(tmpDir: string, name: string, color: string): Buffer {
  const file = path.join(tmpDir, `${name}.jpg`);
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=${color}:s=160x90:d=0.01`,
      '-frames:v', '1',
      file,
    ],
    { stdio: 'ignore' },
  );
  if (result.status !== 0) throw new Error(`Could not create test JPEG ${name}`);
  return fs.readFileSync(file);
}

function probeVideo(file: string): Record<string, string> {
  const result = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=avg_frame_rate,r_frame_rate,nb_frames,duration',
      '-of', 'default=noprint_wrappers=1',
      file,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`ffprobe failed for ${file}`);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('=')),
  );
}

describe('encodeFrames', () => {
  itWithFfmpeg('keeps sub-40ms cadence frames instead of quantizing to 25fps', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdv-capture-test-'));
    try {
      const buffers = [
        makeJpeg(tmpDir, 'red', 'red'),
        makeJpeg(tmpDir, 'green', 'green'),
        makeJpeg(tmpDir, 'blue', 'blue'),
        makeJpeg(tmpDir, 'white', 'white'),
      ];
      const frames: CapturedFrame[] = buffers.map((buffer, i) => ({ buffer, t: [0, 16, 33, 50][i] }));
      const output = path.join(tmpDir, 'out.mp4');

      encodeFrames(frames, output, { fps: 60, tailMs: 0 });

      const info = probeVideo(output);
      expect(info.r_frame_rate).toBe('60/1');
      expect(info.avg_frame_rate).toBe('60/1');
      expect(Number(info.nb_frames)).toBe(4);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
