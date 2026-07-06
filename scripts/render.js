const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FPS = Number(process.env.DEMO_RENDER_FPS || 60);
const JOIN_GAP_MS = 120;
const OUTPUT = path.join(ROOT, 'output', 'demo.mp4');
const TMP_ROOT = path.join(ROOT, 'output', `.render-tmp-${process.pid}`);
const PLAN_PATH = path.join(__dirname, 'browse-plan.json');
const CLIPS_PATH = path.join(__dirname, 'clips.json');
const REMOTION_BIN = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'remotion.cmd' : 'remotion');
const SOURCE_VIDEO = fs.existsSync(path.join(ROOT, 'public', 'raw.mp4'))
  ? path.join(ROOT, 'public', 'raw.mp4')
  : path.join(ROOT, 'recordings', 'raw.mp4');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const plan = readJson(PLAN_PATH);
const rawClips = readJson(CLIPS_PATH);
const meta = plan.meta || {};
const viewport = plan.viewport || {};

const renderMode = process.env.DEMO_RENDER_MODE || 'auto';

// Named quality presets pick an x264 speed/quality trade-off. `draft` keeps preview
// renders fast; `final` produces the deliverable. Explicit DEMO_RENDER_CRF / DEMO_RENDER_PRESET
// still override the preset so existing one-off tuning keeps working.
const QUALITY_PRESETS = {
  draft: { preset: 'veryfast', crf: 26 },
  standard: { preset: 'medium', crf: 20 },
  final: { preset: 'slow', crf: 16 },
};
const quality = String(process.env.DEMO_RENDER_QUALITY || meta.renderQuality || 'draft').toLowerCase();
const qualityPreset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.draft;
const crf = String(process.env.DEMO_RENDER_CRF || qualityPreset.crf);
const preset = process.env.DEMO_RENDER_PRESET || qualityPreset.preset;
const showFfmpegStats = ['1', 'true', 'yes'].includes(String(process.env.DEMO_FFMPEG_STATS || '').toLowerCase());
const ffmpegLogArgs = showFfmpegStats ? ['-hide_banner', '-stats_period', '5'] : ['-hide_banner', '-nostats', '-loglevel', 'warning'];
const playbackSpeed = Number.isFinite(Number(meta.playbackSpeed)) ? Number(meta.playbackSpeed) : 4;
const remotionTimeoutMs = String(process.env.DEMO_REMOTION_TIMEOUT_MS || 120000);
const width = even(Number.isFinite(Number(viewport.width)) ? Number(viewport.width) : 1280);
const height = even(Number.isFinite(Number(viewport.height)) ? Number(viewport.height) : 800);

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

function seconds(n) {
  return Number(n).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function run(cmd, args, label) {
  console.log(`\n${label}`);
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function fullRemotionRender() {
  const cmd = fs.existsSync(REMOTION_BIN) ? REMOTION_BIN : 'remotion';
  run(
    cmd,
    ['render', 'remotion/index.ts', 'DemoVideo', OUTPUT, '--overwrite', `--timeout=${remotionTimeoutMs}`],
    'Rendering all frames with Remotion',
  );
}

function clipSpeed(clip) {
  const speed = Number(clip.speed);
  return Number.isFinite(speed) && speed > 0 ? speed : playbackSpeed;
}

function mergeContinuousClips(clips) {
  const merged = [];
  for (const clip of clips) {
    const clean = {
      ...clip,
      start: Math.max(0, Number(clip.start) || 0),
      end: Math.max(0, Number(clip.end) || 0),
    };
    if (clean.end <= clean.start) {
      continue;
    }

    const prev = merged[merged.length - 1];
    const gap = prev ? clean.start - prev.end : Infinity;
    const sameAction = prev && (prev.action || '') === (clean.action || '');
    const sameSpeed = prev && Math.abs(clipSpeed(prev) - clipSpeed(clean)) < 0.001;
    const sameCrop = prev && Number(prev.topCropPx || 0) === Number(clean.topCropPx || 0);
    if (prev && gap >= 0 && gap <= JOIN_GAP_MS && sameAction && sameSpeed && sameCrop) {
      prev.end = Math.max(prev.end, clean.end);
    } else {
      merged.push(clean);
    }
  }
  return merged;
}

function totalOutputSeconds(clips) {
  return clips.reduce((sum, clip) => sum + (clip.end - clip.start) / 1000 / clipSpeed(clip), 0);
}

function footageSegmentsAfter(clips, skipOutputSeconds) {
  const segments = [];
  let outputCursor = 0;

  for (const clip of clips) {
    const speed = clipSpeed(clip);
    const clipOutput = (clip.end - clip.start) / 1000 / speed;
    const overlapStart = Math.max(0, skipOutputSeconds - outputCursor);
    const overlapEnd = clipOutput;

    if (overlapStart < overlapEnd - 0.0005) {
      const rawStart = clip.start / 1000 + overlapStart * speed;
      const outputDuration = overlapEnd - overlapStart;
      segments.push({
        rawStart,
        rawDuration: outputDuration * speed,
        outputDuration,
        outputFrames: Math.max(1, Math.round(outputDuration * FPS)),
        speed,
      });
    }

    outputCursor += clipOutput;
  }

  return segments;
}

function fastPathBlocker(clips) {
  if (!fs.existsSync(SOURCE_VIDEO)) {
    return `source video not found at ${SOURCE_VIDEO}`;
  }
  if (!clips.length) {
    return 'there are no included clips to render';
  }
  if (meta.captions !== false) {
    return 'captions are enabled';
  }
  if (meta.zoom !== false) {
    return 'zoom/keyframe animation is enabled';
  }
  if (meta.intro || meta.outro || meta.title || meta.subtitle) {
    return 'intro/outro title cards are enabled';
  }
  if (Number(meta.topCropPx || 0) !== 0 || clips.some((clip) => Number(clip.topCropPx || 0) !== 0)) {
    return 'top crop is enabled';
  }
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
    return 'ffmpeg is not available';
  }
  if (meta.loadingOverlay === true && !fs.existsSync(REMOTION_BIN)) {
    return 'Remotion CLI is not installed locally';
  }
  return null;
}

function getVideoDurationMs(file) {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { encoding: 'utf8' },
  );
  const duration = Number.parseFloat((result.stdout || '').trim());
  return Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : 0;
}

function clampClipsToSource(clips, sourceDurationMs) {
  if (!sourceDurationMs) {
    return clips;
  }
  return clips
    .map((clip) => ({
      ...clip,
      start: Math.min(clip.start, sourceDurationMs),
      end: Math.min(clip.end, sourceDurationMs),
    }))
    .filter((clip) => clip.end > clip.start);
}

function renderOverlaySegment(target, frameCount) {
  const cmd = fs.existsSync(REMOTION_BIN) ? REMOTION_BIN : 'remotion';
  run(
    cmd,
    [
      'render',
      'remotion/index.ts',
      'DemoVideo',
      target,
      `--frames=0-${frameCount - 1}`,
      '--overwrite',
      '--muted',
      `--timeout=${remotionTimeoutMs}`,
    ],
    `Rendering ${frameCount} overlay frames with Remotion`,
  );
}

function renderFootageSegment(segment, target, index) {
  const filter = [
    `setpts=(PTS-STARTPTS)/${seconds(segment.speed)}`,
    `fps=${FPS}`,
    `trim=end_frame=${segment.outputFrames}`,
    'setpts=PTS-STARTPTS',
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    'setsar=1',
  ];

  if (Number.isFinite(segment.extraHoldSeconds) && segment.extraHoldSeconds > 0) {
    filter.push(`tpad=stop_mode=clone:stop_duration=${seconds(segment.extraHoldSeconds)}`);
  }

  run(
    'ffmpeg',
    [
      ...ffmpegLogArgs,
      '-y',
      '-ss',
      seconds(segment.rawStart),
      '-t',
      seconds(segment.rawDuration),
      '-i',
      SOURCE_VIDEO,
      '-an',
      '-vf',
      filter.join(','),
      '-c:v',
      'libx264',
      '-preset',
      preset,
      '-crf',
      crf,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      target,
    ],
    `Encoding kept footage segment ${index + 1}`,
  );
}

function concatSegments(files, hasOverlay) {
  if (files.length === 1) {
    fs.copyFileSync(files[0], OUTPUT);
    return;
  }

  if (hasOverlay) {
    const args = [...ffmpegLogArgs, '-y'];
    files.forEach((file) => {
      args.push('-i', file);
    });

    const normalized = files
      .map(
        (_, index) =>
          `[${index}:v]fps=${FPS},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[v${index}]`,
      )
      .join(';');
    const inputs = files.map((_, index) => `[v${index}]`).join('');
    args.push(
      '-filter_complex',
      `${normalized};${inputs}concat=n=${files.length}:v=1:a=0,format=yuv420p[v]`,
      '-map',
      '[v]',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      preset,
      '-crf',
      crf,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      OUTPUT,
    );

    run('ffmpeg', args, 'Joining rendered segments');
    return;
  }

  const listFile = path.join(TMP_ROOT, 'concat.txt');
  fs.writeFileSync(listFile, files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));

  const args = [
    ...ffmpegLogArgs,
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-an',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    OUTPUT,
  ];

  run('ffmpeg', args, 'Joining rendered segments');
}

function fastRender() {
  let clips = mergeContinuousClips(rawClips);
  const blocker = fastPathBlocker(clips);
  if (blocker) {
    if (renderMode === 'fast') {
      throw new Error(`Fast render cannot be used because ${blocker}.`);
    }
    console.log(`Fast render skipped: ${blocker}.`);
    fullRemotionRender();
    return;
  }

  const sourceDurationMs = getVideoDurationMs(SOURCE_VIDEO);
  const maxRequestedEnd = clips.reduce((max, clip) => Math.max(max, clip.end), 0);
  clips = mergeContinuousClips(clampClipsToSource(clips, sourceDurationMs));
  if (!clips.length) {
    throw new Error('All clips fall outside the available source video.');
  }
  if (sourceDurationMs > 0 && maxRequestedEnd > sourceDurationMs) {
    console.log(
      `Clamped clip end from ${seconds(maxRequestedEnd / 1000)}s to source duration ${seconds(sourceDurationMs / 1000)}s.`,
    );
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });

  const files = [];
  const totalSeconds = totalOutputSeconds(clips);
  const overlayFrames =
    meta.loadingOverlay === true
      ? Math.min(Math.round((Number.isFinite(Number(meta.loadingOverlaySeconds)) ? Number(meta.loadingOverlaySeconds) : 3) * FPS), Math.ceil(totalSeconds * FPS))
      : 0;
  const overlaySeconds = overlayFrames / FPS;

  if (overlayFrames > 0) {
    const overlayFile = path.join(TMP_ROOT, 'overlay.mp4');
    renderOverlaySegment(overlayFile, overlayFrames);
    files.push(overlayFile);
  }

  const segments = footageSegmentsAfter(clips, overlaySeconds);
  const finalHoldSeconds = Number(meta.finalHoldSeconds);
  if (segments.length > 0 && Number.isFinite(finalHoldSeconds) && finalHoldSeconds > 0) {
    segments[segments.length - 1].extraHoldSeconds = finalHoldSeconds;
  }
  segments.forEach((segment, index) => {
    const file = path.join(TMP_ROOT, `segment-${String(index + 1).padStart(2, '0')}.mp4`);
    renderFootageSegment(segment, file, index);
    files.push(file);
  });

  if (!files.length) {
    throw new Error('No renderable segments were produced.');
  }

  concatSegments(files, overlayFrames > 0);
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  console.log(`\nFast render complete: ${path.relative(ROOT, OUTPUT)}`);
}

try {
  console.log(`Render quality: ${quality} (x264 preset ${preset}, crf ${crf})`);
  if (renderMode === 'full') {
    fullRemotionRender();
  } else {
    fastRender();
  }
} catch (error) {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
