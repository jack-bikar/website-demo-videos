'use client';

import { Player } from '@remotion/player';
import { DemoVideo, demoVideoMetadata } from '@wdv/compositions';
import type { DemoVideoProps } from '@wdv/schema';

export default function PlayerPreview({ props }: { props: DemoVideoProps }) {
  const metadata = demoVideoMetadata(props);
  return (
    <div className="player-shell">
      <Player
        component={DemoVideo}
        inputProps={props}
        durationInFrames={metadata.durationInFrames}
        fps={metadata.fps}
        compositionWidth={metadata.width}
        compositionHeight={metadata.height}
        controls
        style={{ width: '100%', aspectRatio: `${metadata.width} / ${metadata.height}` }}
      />
    </div>
  );
}
