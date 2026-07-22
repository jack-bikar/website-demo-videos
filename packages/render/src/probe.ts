import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

function parseFps(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.trim().split('/').map(Number);
  if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return num / den;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getDurationSeconds(file: string): number {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { encoding: 'utf8' },
  );
  const duration = Number.parseFloat((result.stdout || '').trim());
  return Number.isFinite(duration) ? duration : 0;
}

export function getVideoDurationMs(file: string): number {
  const seconds = getDurationSeconds(file);
  return seconds > 0 ? Math.round(seconds * 1000) : 0;
}

export function getVideoFps(file: string): number {
  const result = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=avg_frame_rate,r_frame_rate',
      '-of',
      'default=noprint_wrappers=1',
      file,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return 0;

  const values = Object.fromEntries(
    (result.stdout || '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('=')),
  );
  return parseFps(values.avg_frame_rate) || parseFps(values.r_frame_rate);
}

export function isValidVideo(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  return result.status === 0;
}

export function ffmpegAvailable(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}
