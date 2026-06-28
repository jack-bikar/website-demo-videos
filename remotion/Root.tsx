import { Composition } from 'remotion';
import { DemoVideo, FPS, VIDEO_H, VIDEO_W, totalDurationInFrames, type Clip } from './DemoVideo';
import clipsData from '../scripts/clips.json';

const clips = clipsData as Clip[];

const WIDTH = VIDEO_W;
const HEIGHT = VIDEO_H;

// Intro card + per-clip sped-up footage + outro card, in output frames (see DemoVideo).
// Fall back to a short placeholder length so the studio opens before the first recording.
const durationInFrames = Math.max(totalDurationInFrames(clips), 60);

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
