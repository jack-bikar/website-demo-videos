import { Composition } from 'remotion';
import { DemoVideo, FPS, PLAYBACK_SPEED, type Clip } from './DemoVideo';
import clipsData from '../scripts/clips.json';

const clips = clipsData as Clip[];

const WIDTH = 1280;
const HEIGHT = 800;

// Total kept footage (ms, original timeline) → output ms after the 4x speed-up → frames.
const totalFootageMs = clips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0);
const outputMs = totalFootageMs / PLAYBACK_SPEED;
const computedFrames = Math.round((outputMs / 1000) * FPS);

// Fall back to a short placeholder length so the studio opens before the first recording.
const durationInFrames = Math.max(computedFrames, 60);

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="DemoVideo"
      component={DemoVideo}
      durationInFrames={durationInFrames}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  );
};
