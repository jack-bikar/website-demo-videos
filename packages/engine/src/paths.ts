import path from 'node:path';

/**
 * Single source of truth for the on-disk project layout. DB rows hold editable intent;
 * bulky/derived artifacts live here, keyed by project/take/render ids, so regeneration
 * is "delete dir contents and re-run" and never clobbers DB-held user edits.
 */

export interface TakePaths {
  root: string;
  rawMp4: string;
  smoothMp4: string;
  moments: string;
  clips: string;
  keyframes: string;
}

export function projectRoot(dataDir: string, projectId: string): string {
  return path.join(dataDir, 'projects', projectId);
}

export function takePaths(dataDir: string, projectId: string, takeId: string): TakePaths {
  const root = path.join(projectRoot(dataDir, projectId), 'takes', takeId);
  return {
    root,
    rawMp4: path.join(root, 'raw.mp4'),
    smoothMp4: path.join(root, 'smooth.mp4'),
    moments: path.join(root, 'moments.json'),
    clips: path.join(root, 'clips.json'),
    keyframes: path.join(root, 'keyframes.json'),
  };
}

export function renderOutputPath(dataDir: string, projectId: string, renderId: string): string {
  return path.join(projectRoot(dataDir, projectId), 'renders', `${renderId}.mp4`);
}
