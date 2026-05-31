import { Config } from '@remotion/cli/config';

// The captured footage is the input; H.264 MP4 is a sensible default output.
Config.setVideoImageFormat('jpeg');
Config.setCodec('h264');
Config.overrideWebpackConfig((config) => config);
