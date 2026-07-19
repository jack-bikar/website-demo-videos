import React from 'react';
import { Composition } from 'remotion';
import { demoVideoPropsSchema, type DemoVideoProps } from '@wdv/schema';
import { DemoVideo, demoVideoMetadata, FPS } from '@wdv/compositions';
import clipsData from '../scripts/clips.json';
import keyframesData from '../scripts/keyframes.json';
import browsePlan from '../scripts/browse-plan.json';

/**
 * Legacy-file-mode studio adapter: feeds the shared composition the current
 * scripts/*.json artifacts so `npm run studio` previews the latest recording.
 * The composition itself lives in @wdv/compositions and is fully props-driven.
 */
const plan = browsePlan as { viewport?: DemoVideoProps['viewport']; meta?: DemoVideoProps['meta'] };

const props: DemoVideoProps = demoVideoPropsSchema.parse({
  videoSrc: 'raw.mp4',
  viewport: plan.viewport ?? { width: 1280, height: 800 },
  clips: clipsData,
  keyframes: keyframesData,
  meta: plan.meta ?? {},
});

const metadata = demoVideoMetadata(props);

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="DemoVideo"
      component={DemoVideo}
      schema={demoVideoPropsSchema}
      defaultProps={props}
      durationInFrames={metadata.durationInFrames}
      fps={FPS}
      width={metadata.width}
      height={metadata.height}
    />
  );
};
