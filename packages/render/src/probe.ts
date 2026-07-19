import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

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
