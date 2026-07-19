import React from 'react';
import { Composition } from 'remotion';
import { demoVideoPropsSchema, type DemoVideoProps } from '@wdv/schema';
import { DemoVideo, demoVideoMetadata, FPS } from './walkthrough/DemoVideo';

/** Placeholder props so the studio opens before any recording exists. */
const defaultProps: DemoVideoProps = {
  videoSrc: 'raw.mp4',
  viewport: { width: 1280, height: 800 },
  clips: [],
  keyframes: [],
  meta: {},
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="DemoVideo"
      component={DemoVideo}
      schema={demoVideoPropsSchema}
      defaultProps={defaultProps}
      fps={FPS}
      width={defaultProps.viewport.width}
      height={defaultProps.viewport.height}
      durationInFrames={60}
      calculateMetadata={({ props }) => demoVideoMetadata(props)}
    />
  );
};
