#!/usr/bin/env node
/**
 * Preview server — watch, cut, and tune the demo video in real time.
 *
 * GET  /            → editor UI
 * GET  /video       → rendered output/demo.mp4 (range-aware)
 * GET  /config      → meta from browse-plan.json
 * POST /config      → patch meta fields
 * GET  /clips       → scripts/clips.json
 * POST /clips       → save scripts/clips.json
 * GET  /video-info  → raw recording duration via ffprobe
 * POST /render      → run `npm run render`, stream via SSE
 * GET  /events      → SSE stream
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT       = path.resolve(__dirname, '..');
const PLAN_PATH  = path.join(ROOT, 'scripts', 'browse-plan.json');
const CLIPS_PATH = path.join(ROOT, 'scripts', 'clips.json');
const VIDEO_PATH = path.join(ROOT, 'output', 'demo.mp4');
const RAW_PATH   = path.join(ROOT, 'recordings', 'raw.mp4');
const HOST       = process.env.HOST || '127.0.0.1';
const PORT       = Number(process.env.PORT || 4321);

// ── SSE ─────────────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch (_) {} }
}

// ── Data helpers ─────────────────────────────────────────────────────────────
const readPlan  = () => JSON.parse(fs.readFileSync(PLAN_PATH,  'utf8'));
const writePlan = (p) => fs.writeFileSync(PLAN_PATH,  JSON.stringify(p, null, 2));
const readClips  = () => fs.existsSync(CLIPS_PATH) ? JSON.parse(fs.readFileSync(CLIPS_PATH, 'utf8')) : [];
const writeClips = (c) => fs.writeFileSync(CLIPS_PATH, JSON.stringify(c, null, 2));

function getRawDuration() {
  if (!fs.existsSync(RAW_PATH)) return 0;
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', RAW_PATH,
  ], { encoding: 'utf8' });
  const s = parseFloat(r.stdout.trim());
  return Number.isFinite(s) ? Math.round(s * 1000) : 0;
}

// ── Video serving ────────────────────────────────────────────────────────────
function serveFile(req, res, filePath, mime) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('File not found: ' + path.relative(ROOT, filePath));
  }
  const total = fs.statSync(filePath).size;
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10);
    const end   = e ? parseInt(e, 10) : total - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
  }
}

// ── Render ───────────────────────────────────────────────────────────────────
let renderProcess = null;
function startRender() {
  if (renderProcess) { broadcast('render-log', { text: 'Already rendering…\n' }); return; }
  broadcast('render-start', {});
  renderProcess = spawn('npm', ['run', 'render'], { cwd: ROOT, shell: true, stdio: 'pipe' });
  const fwd = (d) => broadcast('render-log', { text: d.toString() });
  renderProcess.stdout.on('data', fwd);
  renderProcess.stderr.on('data', fwd);
  renderProcess.on('close', (code) => {
    renderProcess = null;
    broadcast('render-done', { success: code === 0 });
  });
}

// ── HTML ─────────────────────────────────────────────────────────────────────
const HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" href="data:,"/>
<title>Demo Editor</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#090909;--surface:#151412;--surface2:#1d1b18;--surface3:#24211d;--border:#34302a;
  --accent:#e11d48;--accent-hi:#fb7185;--accent-lo:rgba(225,29,72,.14);
  --keep:#14b8a6;--keep-hi:#5eead4;--keep-lo:rgba(20,184,166,.22);
  --warn:#f59e0b;--ok:#22c55e;--text:#f4f1ea;--muted:#9b958b;--muted2:#c0b7aa;
  --radius:8px;--font:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font)}
/* Lock the whole tool to the viewport: video flexes to fill the top, the control dock stays a
   compact fixed-height strip at the bottom — so the preview is always fully visible. */
body{height:100dvh;overflow:hidden;display:flex;flex-direction:column;align-items:center;
  padding:12px;gap:10px}

/* ── Video ── */
.video-wrap{flex:1 1 auto;min-height:0;width:100%;max-width:1220px;display:flex;
  align-items:center;justify-content:center}
.player-shell{max-width:100%;height:100%;max-height:100%;min-height:0;display:flex;
  flex-direction:column;align-items:stretch;justify-content:center;gap:8px}
video{flex:1 1 auto;min-height:0;max-width:100%;max-height:100%;width:auto;height:auto;border-radius:var(--radius);
  background:#000;box-shadow:0 16px 44px rgba(0,0,0,.7)}
.virtual-controls{display:flex;align-items:center;gap:10px;background:var(--surface);
  border:1px solid var(--border);border-radius:8px;padding:8px 10px;box-shadow:0 10px 28px rgba(0,0,0,.32)}
.virtual-controls.hidden{display:none}
.transport-btn{border:1px solid var(--border);background:var(--surface3);color:var(--text);
  width:34px;height:30px;border-radius:6px;font-size:13px;font-weight:900;cursor:pointer}
.transport-btn:hover{border-color:var(--accent)}
.virtual-time{font-size:12px;font-weight:800;color:var(--muted2);min-width:84px;text-align:right}
.virtual-scrubber{flex:1;min-width:140px}

/* ── Dock (compact control strip) ── */
.dock{flex:0 0 auto;width:100%;max-width:1220px;background:var(--surface);
  border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;
  display:flex;flex-direction:column;gap:12px;box-shadow:0 10px 32px rgba(0,0,0,.35)}
.dock-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.dock-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dock-description{font-size:12px;line-height:1.35;color:var(--muted2)}
.dock-row{display:flex;align-items:stretch;gap:14px;flex-wrap:wrap}
.dock-group{display:flex;align-items:center;gap:10px;min-width:0}
.control-group{align-items:stretch;flex-direction:column;gap:8px}
.control-main{display:flex;align-items:center;gap:10px;min-width:0}
.dock-sep{width:1px;align-self:stretch;background:var(--border);margin:2px 0}
.panel-title{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;
  color:var(--muted)}
.field-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.field-title{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--text)}
.field-help{font-size:11px;line-height:1.35;color:var(--muted);max-width:320px}
.mode-tabs{display:flex;align-items:center;gap:4px;padding:3px;border:1px solid var(--border);
  background:var(--surface2);border-radius:8px;flex-shrink:0}
.mode-btn{border:0;background:transparent;color:var(--muted2);border-radius:6px;padding:7px 11px;
  font-size:12px;font-weight:800;cursor:pointer;transition:background .15s,color .15s}
.mode-btn:hover{color:var(--text)}
.mode-btn.active{background:var(--text);color:#171410}

/* ── Speed ── */
.speed-num{font-size:24px;font-weight:800;min-width:50px;text-align:right;line-height:1}
.speed-unit{font-size:12px;font-weight:500;color:var(--muted);margin-left:1px}
.slider-col{flex:1;min-width:120px;display:flex;flex-direction:column;gap:6px}
input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:4px;
  border-radius:99px;background:var(--border);outline:none;cursor:pointer}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
  width:18px;height:18px;border-radius:50%;background:var(--accent);cursor:pointer;
  box-shadow:0 0 8px rgba(220,38,38,.5);transition:transform .1s,box-shadow .1s}
input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.2);box-shadow:0 0 14px rgba(220,38,38,.7)}
.tick-row{display:flex;justify-content:space-between;padding:0 1px}
.tick{font-size:10px;color:var(--muted)}
.presets{display:flex;gap:6px;flex-wrap:wrap}
.preset{padding:5px 12px;border-radius:6px;border:1px solid var(--border);
  background:transparent;color:var(--muted2);font-size:12px;font-weight:700;cursor:pointer;transition:all .15s}
.preset:hover{border-color:var(--accent);color:var(--text)}
.preset.active{background:var(--accent);border-color:var(--accent);color:#fff}

/* ── Length ── */
.sub-label{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
  color:var(--muted)}
.length-input{background:var(--surface3);border:1px solid var(--border);border-radius:6px;
  color:var(--text);padding:6px 8px;font-size:15px;font-weight:800;width:68px;text-align:right;outline:none}
.length-input:focus{border-color:var(--accent)}
.length-unit{font-size:12px;font-weight:500;color:var(--muted)}
.length-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:15px}
.inline-metric{font-size:11px;font-weight:700;color:var(--muted2)}
.length-hint{font-size:11px;color:var(--muted);min-width:0}
.length-hint.clamped{color:var(--accent-hi)}

/* ── Timeline ── */
.timeline-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px}
.timeline-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.timeline-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end}
.timeline-stats{font-size:11px;font-weight:700;color:var(--muted2);white-space:nowrap}
.legend{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.legend-item{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted2);font-weight:700}
.swatch{width:15px;height:8px;border-radius:2px;border:1px solid var(--border)}
.swatch.keep{background:var(--keep-lo);border-color:var(--keep)}
.swatch.cut{background:repeating-linear-gradient(45deg,rgba(255,255,255,.03),rgba(255,255,255,.03) 4px,transparent 4px,transparent 8px)}
.inline-check{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:var(--muted2);white-space:nowrap}
.inline-check input{accent-color:var(--accent)}
.ruler{height:14px;position:relative;user-select:none}
.ruler-tick{position:absolute;top:0;display:flex;flex-direction:column;align-items:center;gap:1px}
.ruler-line{width:1px;height:4px;background:var(--border)}
.ruler-label{font-size:9px;color:var(--muted);white-space:nowrap;transform:translateX(-50%)}
.timeline-bar{position:relative;height:48px;background:var(--surface2);border-radius:8px;
  overflow:hidden;border:1px solid var(--border);cursor:default}
.dead-zone{position:absolute;top:0;bottom:0;background:repeating-linear-gradient(
  45deg,transparent,transparent 4px,rgba(255,255,255,.035) 4px,rgba(255,255,255,.035) 8px)}
.dead-zone-label{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  color:var(--muted);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap}
.clip-seg{position:absolute;top:0;bottom:0;background:var(--keep-lo);
  border-left:2px solid var(--keep);border-right:2px solid var(--keep);
  display:flex;align-items:center;cursor:pointer;transition:background .15s;user-select:none}
.clip-seg:hover{background:rgba(20,184,166,.32)}
.clip-seg.selected{background:rgba(225,29,72,.28);border-color:var(--accent-hi);box-shadow:inset 0 0 0 1px rgba(251,113,133,.45)}
.handle{position:absolute;top:0;bottom:0;width:10px;z-index:2;cursor:ew-resize;
  display:flex;align-items:center;justify-content:center}
.handle-l{left:-1px}
.handle-r{right:-1px}
.handle::after{content:'';width:3px;height:18px;border-radius:2px;
  background:rgba(255,255,255,.3);transition:background .15s}
.handle:hover::after,.clip-seg.selected .handle::after{background:rgba(255,255,255,.7)}
.clip-inner{flex:1;padding:0 12px;overflow:hidden;pointer-events:none}
.clip-name{display:block;font-size:11px;font-weight:600;color:var(--text);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.clip-dur{display:block;font-size:9px;color:var(--muted2);margin-top:1px}
.playhead{position:absolute;top:0;bottom:0;width:2px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.35),0 0 12px rgba(255,255,255,.5);
  pointer-events:none;z-index:5}
.playhead::before{content:'';position:absolute;top:0;left:50%;transform:translate(-50%,-1px);
  width:10px;height:7px;border-radius:0 0 4px 4px;background:#fff}

/* ── Clip details (compact, inline) ── */
.empty-detail{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:10px 12px;border:1px dashed var(--border);border-radius:8px;color:var(--muted);
  font-size:12px;line-height:1.35}
.empty-detail.hidden{display:none}
.clip-detail{display:flex;align-items:center;gap:14px;flex-wrap:wrap;
  padding-top:10px;border-top:1px solid var(--border)}
.clip-detail.hidden{display:none}
.detail-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.detail-summary{display:flex;flex-direction:column;gap:2px;min-width:160px;max-width:260px}
.detail-title{font-size:12px;font-weight:800;color:var(--text)}
.detail-action{font-size:11px;color:var(--muted2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.detail-block{display:flex;flex-direction:column;gap:5px}
.time-inputs{display:flex;gap:6px;align-items:center}
.time-input{background:var(--surface3);border:1px solid var(--border);border-radius:6px;
  color:var(--text);padding:4px 7px;font-size:12px;width:66px;text-align:center;outline:none}
.time-input:focus{border-color:var(--accent)}
.time-sep{color:var(--muted);font-size:11px}
.duration-pill{font-size:11px;font-weight:800;color:var(--text);background:var(--surface3);
  border:1px solid var(--border);border-radius:6px;padding:5px 8px;white-space:nowrap}
.range-hint{font-size:11px;line-height:1.25;color:var(--warn);max-width:260px}
.toggle{position:relative;width:34px;height:19px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0}
.toggle-track{position:absolute;inset:0;background:var(--border);border-radius:20px;cursor:pointer;transition:background .2s}
.toggle input:checked+.toggle-track{background:var(--accent)}
.toggle-thumb{position:absolute;top:3px;left:3px;width:13px;height:13px;background:#fff;
  border-radius:50%;transition:transform .2s;pointer-events:none}
.toggle input:checked~.toggle-thumb{transform:translateX(15px)}
.toggle-label{font-size:11px;color:var(--muted2)}
.clip-speed-row{display:flex;align-items:center;gap:10px;flex:1;min-width:160px}
.clip-speed-num{font-size:16px;font-weight:700;min-width:42px;text-align:right;line-height:1}
.button-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.btn{padding:6px 12px;border-radius:6px;border:1px solid var(--border);background:transparent;
  color:var(--muted2);font-size:11px;font-weight:600;cursor:pointer;transition:all .15s}
.btn:hover{border-color:var(--accent);color:var(--text)}
.btn:disabled{opacity:.38;cursor:not-allowed}
.btn:disabled:hover{border-color:var(--border);color:var(--muted2)}
.btn.danger:hover{border-color:#ef4444;color:#ef4444}

/* ── Render ── */
.render-btn{padding:9px 20px;background:var(--accent);border:none;border-radius:8px;
  color:#fff;font-size:13px;font-weight:700;letter-spacing:.03em;cursor:pointer;
  transition:background .15s,transform .1s;flex-shrink:0}
.render-btn:hover:not(:disabled){background:var(--accent-hi);transform:translateY(-1px)}
.render-btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.render-status{font-size:12px;font-weight:600;color:var(--muted);display:flex;align-items:center;gap:8px}
.spinner{width:13px;height:13px;border:2px solid var(--border);border-top-color:var(--accent);
  border-radius:50%;animation:spin .7s linear infinite;display:none}
.spinner.on{display:block}
pre.log{background:#060b12;border:1px solid var(--border);border-radius:8px;padding:10px 12px;
  font-size:11px;line-height:1.55;color:#7a90b0;overflow-y:auto;max-height:120px;
  white-space:pre-wrap;word-break:break-all;display:none}
pre.log.on{display:block}

hr.divider{border:none;border-top:1px solid var(--border)}
@keyframes spin{to{transform:rotate(360deg)}}
@media (max-width:760px){
  body{padding:8px}
  .dock{padding:12px}
  .dock-head,.timeline-head{align-items:stretch;flex-direction:column}
  .mode-tabs{width:100%}
  .mode-btn{flex:1}
  .dock-sep{display:none}
  .dock-group{width:100%}
  .control-group{min-width:100%!important}
  .timeline-tools{justify-content:flex-start}
  .timeline-stats{white-space:normal}
  .clip-detail{align-items:flex-start}
}
</style>
</head>
<body>

<div class="video-wrap">
  <div class="player-shell">
    <video id="vid" controls loop preload="metadata" src="/video" type="video/mp4"></video>
    <div class="virtual-controls hidden" id="virtualControls">
      <button class="transport-btn" id="virtualPlayBtn" type="button" aria-label="Play preview">▶</button>
      <input class="virtual-scrubber" id="virtualScrubber" type="range" min="0" max="1000" step="1" value="0" aria-label="Kept-section preview position"/>
      <span class="virtual-time" id="virtualTime">0:00 / 0:00</span>
    </div>
  </div>
</div>

<!-- Compact control dock -->
<div class="dock">
  <div class="dock-head">
    <div class="dock-copy">
      <div class="panel-title">Video editor</div>
      <div class="dock-description" id="previewDescription">Rendered MP4 preview. Re-render after edits to refresh the final file.</div>
    </div>
    <div class="mode-tabs" role="tablist" aria-label="Preview mode">
      <button class="mode-btn active" data-mode="rendered" type="button">Rendered</button>
      <button class="mode-btn" data-mode="source" type="button">Source trim</button>
    </div>
  </div>

  <!-- Row 1: speed · target output · render -->
  <div class="dock-row">
    <div class="dock-group control-group" style="flex:1;min-width:280px">
      <div class="field-head">
        <label class="field-title" for="gSlider">Playback speed</label>
        <div class="field-help">Applies to every included section unless that section has its own speed.</div>
      </div>
      <div class="control-main">
        <div class="speed-num" id="gSpeedNum">1.0<span class="speed-unit">×</span></div>
        <div class="slider-col"><input type="range" id="gSlider" min="0.5" max="2.5" step="0.05" value="1" aria-label="Global playback speed"/></div>
      </div>
      <div class="presets" id="gPresets">
        <button class="preset" data-v="1" type="button">1x</button>
        <button class="preset" data-v="1.2" type="button">1.2x</button>
        <button class="preset" data-v="1.5" type="button">1.5x</button>
      </div>
    </div>

    <div class="dock-sep"></div>

    <div class="dock-group control-group" style="flex:1;min-width:300px">
      <div class="field-head">
        <label class="field-title" for="lengthInput">Target final duration</label>
        <div class="field-help">Solves the global speed needed for that duration. Use the timeline to remove footage.</div>
      </div>
      <div class="control-main">
        <input type="number" class="length-input" id="lengthInput" min="3" max="180" step="0.5" aria-label="Target final duration in seconds"/>
        <span class="length-unit">sec</span>
        <div class="slider-col"><input type="range" id="lengthSlider" min="6" max="45" step="0.5" aria-label="Target final duration slider"/></div>
      </div>
      <div class="length-meta">
        <span class="inline-metric" id="durationReadout"></span>
        <span class="length-hint" id="lengthHint"></span>
      </div>
    </div>

    <div class="dock-sep"></div>

    <div class="dock-group control-group" style="min-width:210px">
      <div class="field-head">
        <div class="field-title">Output file</div>
      </div>
      <div class="sub-label">Render quality</div>
      <div class="presets" id="qualityPresets">
        <button class="preset" data-q="draft" type="button">Draft</button>
        <button class="preset" data-q="standard" type="button">Standard</button>
        <button class="preset" data-q="final" type="button">Final</button>
      </div>
      <div class="field-help" style="max-width:210px">Draft = fast preview. Final = slow encode, best quality.</div>
      <button class="render-btn" id="renderBtn" type="button">Render edited MP4</button>
      <div class="render-status">
        <div class="spinner" id="spinner"></div>
        <span id="renderStatus">Ready</span>
      </div>
    </div>
  </div>

  <!-- Row 2: timeline -->
  <div class="timeline-head">
    <div class="timeline-copy">
      <div class="field-title">Cut timeline</div>
      <div class="field-help">Included sections stay in the video. Gaps are excluded from the next render.</div>
    </div>
    <div class="timeline-tools">
      <div class="legend" aria-hidden="true">
        <span class="legend-item"><span class="swatch keep"></span>Included</span>
        <span class="legend-item"><span class="swatch cut"></span>Cut out</span>
      </div>
      <span class="inline-check">Playback skips cut-out footage</span>
      <button class="btn" id="mergeAllBtn" type="button">Merge touching sections</button>
      <div class="timeline-stats" id="timelineStats"></div>
    </div>
  </div>
  <div class="ruler" id="ruler"></div>
  <div class="timeline-bar" id="timelineBar"></div>

  <!-- Row 3: per-section detail (inline, only when a section is selected) -->
  <div class="empty-detail" id="emptyDetail">
    <span>Select an included section to adjust its range, speed, split point, or removal from the final video.</span>
  </div>
  <div class="clip-detail hidden" id="clipDetail">
    <div class="detail-summary">
      <span class="detail-label" id="clipTitle">Section</span>
      <span class="detail-action" id="clipAction"></span>
    </div>

    <div class="detail-block">
      <span class="detail-label">Source range</span>
      <div class="time-inputs">
        <input type="number" class="time-input" id="clipStart" step="0.1" title="Start in source footage, seconds" aria-label="Section start in source seconds"/>
        <span class="time-sep">to</span>
        <input type="number" class="time-input" id="clipEnd" step="0.1" title="End in source footage, seconds" aria-label="Section end in source seconds"/>
        <span class="time-sep" style="font-size:10px;color:var(--muted)" id="clipRawDur"></span>
      </div>
      <span class="range-hint" id="rangeHint"></span>
    </div>

    <div class="detail-block">
      <span class="detail-label">Final length</span>
      <span class="duration-pill" id="clipOutDur"></span>
    </div>

    <div class="dock-sep"></div>

    <div class="detail-block" style="min-width:220px;flex:1">
      <span class="detail-label">Section speed</span>
      <div class="control-main">
        <label class="toggle">
          <input type="checkbox" id="speedOverrideToggle" aria-label="Use custom speed for selected section"/>
          <div class="toggle-track"></div>
          <div class="toggle-thumb"></div>
        </label>
        <span class="toggle-label" id="toggleLabel">Using global speed</span>
      </div>
      <div class="clip-speed-row" id="clipSpeedRow" style="opacity:.3;pointer-events:none">
        <div class="clip-speed-num" id="clipSpeedNum">1.0<span class="speed-unit">×</span></div>
        <div class="slider-col"><input type="range" id="clipSlider" min="0.5" max="2.5" step="0.05" value="1" aria-label="Selected section speed"/></div>
      </div>
    </div>

    <div class="dock-sep"></div>

    <div class="button-row">
      <button class="btn" id="setStartBtn" type="button">Set start</button>
      <button class="btn" id="setEndBtn" type="button">Set end</button>
      <button class="btn" id="mergeBtn" type="button">Merge adjacent</button>
      <button class="btn" id="splitBtn" type="button">Split at playhead</button>
      <button class="btn danger" id="deleteBtn" type="button">Remove section</button>
    </div>
  </div>

  <pre class="log" id="log"></pre>
</div>

<script>
// ── State ───────────────────────────────────────────────────────────────────
const vid = document.getElementById('vid');
const RENDERED_SRC = '/video';
const SOURCE_SRC = '/raw-video';
const SPEED_MIN = 0.5;
const SPEED_MAX = 2.5;
const MIN_CLIP_MS = 200;
const JOIN_GAP_MS = 120;

let clips = [];
let rawDuration = 1;
let globalSpeed = 1;
let selectedIdx = null;
let dragState = null;
let previewMode = 'rendered';
let renderedBust = '';

const gSlider = document.getElementById('gSlider');
const gSpeedNum = document.getElementById('gSpeedNum');
const lengthInput = document.getElementById('lengthInput');
const lengthSlider = document.getElementById('lengthSlider');
const lengthHint = document.getElementById('lengthHint');
const durationReadout = document.getElementById('durationReadout');
const timelineStats = document.getElementById('timelineStats');
const renderStatus = document.getElementById('renderStatus');
const previewDescription = document.getElementById('previewDescription');
const virtualControls = document.getElementById('virtualControls');
const virtualPlayBtn = document.getElementById('virtualPlayBtn');
const virtualScrubber = document.getElementById('virtualScrubber');
const virtualTime = document.getElementById('virtualTime');

vid.dataset.mode = 'rendered';

// ── Init ────────────────────────────────────────────────────────────────────
Promise.all([
  fetch('/config').then(r => r.json()),
  fetch('/clips').then(r => r.json()),
  fetch('/video-info').then(r => r.json()),
]).then(([cfg, cls, info]) => {
  globalSpeed = cfg.playbackSpeed ?? 1;
  rawDuration = Math.max(1, info.durationMs || 0);
  const normalized = normalizeClips(Array.isArray(cls) ? cls : [], rawDuration);
  clips = normalized.clips;
  if (normalized.changed) saveClips();
  setGlobalSpeed(globalSpeed, false);
  setRenderQuality(cfg.renderQuality || 'draft', false);
  setPreviewMode('rendered');
  renderTimeline();
}).catch(err => {
  renderStatus.textContent = 'Could not load editor data';
  renderStatus.style.color = 'var(--accent)';
  console.error(err);
});

// ── Utility ─────────────────────────────────────────────────────────────────
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeClips(input, durationMs) {
  const out = [];
  let changed = false;
  let floor = 0;
  input.forEach((clip) => {
    if (durationMs < MIN_CLIP_MS || floor > durationMs - MIN_CLIP_MS) {
      changed = true;
      return;
    }
    const originalStart = Number(clip.start);
    const originalEnd = Number(clip.end);
    let start = Number.isFinite(originalStart) ? Math.round(originalStart) : 0;
    let end = Number.isFinite(originalEnd) ? Math.round(originalEnd) : start;
    start = clamp(start, floor, durationMs - MIN_CLIP_MS);
    end = clamp(end, start + MIN_CLIP_MS, durationMs);
    if (end - start < MIN_CLIP_MS) {
      changed = true;
      return;
    }
    const next = { ...clip, start, end };
    out.push(next);
    floor = end;
    if (start !== originalStart || end !== originalEnd) changed = true;
  });
  return { clips: out, changed };
}

function fmtSeconds(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0.0s';
  if (sec >= 60) {
    const minutes = Math.floor(sec / 60);
    const seconds = Math.round(sec - minutes * 60);
    return String(minutes) + ':' + String(seconds).padStart(2, '0');
  }
  return (Math.round(sec * 10) / 10).toFixed(1) + 's';
}

function fmtSpeed(v) {
  return (Math.round(v * 100) / 100).toString().replace(/(\\.\\d*?)0+$/, '$1').replace(/\\.$/, '')
    + '<span class="speed-unit">x</span>';
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function clipSpeed(clip) {
  return Number.isFinite(clip.speed) ? clip.speed : globalSpeed;
}

function clipSpeedKey(clip) {
  return Number.isFinite(clip.speed) ? Math.round(clip.speed * 1000) / 1000 : 'global';
}

function canMergePair(idx) {
  if (idx < 0 || idx >= clips.length - 1) return false;
  const a = clips[idx];
  const b = clips[idx + 1];
  const gap = b.start - a.end;
  return gap >= 0 && gap <= JOIN_GAP_MS && clipSpeedKey(a) === clipSpeedKey(b);
}

function mergePair(idx) {
  if (!canMergePair(idx)) return false;
  const a = clips[idx];
  const b = clips[idx + 1];
  const merged = {
    ...a,
    end: Math.max(a.end, b.end),
    action: a.action || b.action,
    type: a.type || b.type,
  };
  if (Number.isFinite(a.speed)) merged.speed = a.speed;
  else delete merged.speed;
  clips.splice(idx, 2, merged);
  selectedIdx = idx;
  return true;
}

function selectedMergePairIndex() {
  if (selectedIdx === null) return -1;
  if (canMergePair(selectedIdx)) return selectedIdx;
  if (canMergePair(selectedIdx - 1)) return selectedIdx - 1;
  return -1;
}

function hasMergeablePair() {
  return clips.some((_, i) => canMergePair(i));
}

function renderedSrc() {
  return RENDERED_SRC + renderedBust;
}

// ── Preview mode ────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => setPreviewMode(btn.dataset.mode));
});

function setPreviewMode(mode, seekSeconds) {
  previewMode = mode === 'source' ? 'source' : 'rendered';
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === previewMode);
  });
  previewDescription.textContent = previewMode === 'source'
    ? 'Source trim preview. Use the player position to choose exact section starts, ends, and split points.'
    : 'Rendered MP4 preview. Re-render after edits to refresh the final file.';

  const nextSrc = previewMode === 'source' ? SOURCE_SRC : renderedSrc();
  const applySeek = () => {
    const fallbackSource = clips.length ? clips[0].start / 1000 : 0;
    const target = Number.isFinite(seekSeconds) ? seekSeconds : (previewMode === 'source' ? fallbackSource : 0);
    if (Number.isFinite(target)) vid.currentTime = clamp(target, 0, Math.max(0, rawDuration / 1000));
    applyPreviewPlaybackRate();
    updateVirtualControls();
    renderPlayhead();
    updateClipActionButtons();
  };

  if (vid.dataset.mode !== previewMode || vid.getAttribute('src') !== nextSrc) {
    vid.dataset.mode = previewMode;
    vid.src = nextSrc;
    vid.controls = previewMode !== 'source';
    vid.loop = previewMode !== 'source';
    virtualControls.classList.toggle('hidden', previewMode !== 'source');
    vid.load();
    vid.addEventListener('loadedmetadata', applySeek, { once: true });
  } else {
    vid.controls = previewMode !== 'source';
    vid.loop = previewMode !== 'source';
    virtualControls.classList.toggle('hidden', previewMode !== 'source');
    applySeek();
  }
  renderTimeline();
}

function seekSourceMs(ms) {
  setPreviewMode('source', clamp(ms, 0, rawDuration) / 1000);
}

function findClipIndexAt(ms) {
  return clips.findIndex(c => ms >= c.start && ms < c.end);
}

function nextClipIndexAfter(ms) {
  return clips.findIndex(c => c.start > ms);
}

function virtualDurationSec() {
  return clips.reduce((sum, clip) => sum + ((clip.end - clip.start) / 1000 / Math.max(0.1, clipSpeed(clip))), 0);
}

function sourceMsToVirtualSec(ms) {
  let acc = 0;
  for (const clip of clips) {
    const speed = Math.max(0.1, clipSpeed(clip));
    if (ms < clip.start) return acc;
    if (ms <= clip.end) return acc + ((ms - clip.start) / 1000 / speed);
    acc += (clip.end - clip.start) / 1000 / speed;
  }
  return acc;
}

function virtualSecToSourceMs(sec) {
  let acc = 0;
  for (const clip of clips) {
    const speed = Math.max(0.1, clipSpeed(clip));
    const clipOut = (clip.end - clip.start) / 1000 / speed;
    if (sec <= acc + clipOut) {
      return clamp(Math.round(clip.start + (sec - acc) * 1000 * speed), clip.start, clip.end);
    }
    acc += clipOut;
  }
  return clips.length ? clips[clips.length - 1].end : 0;
}

function fmtClock(sec) {
  sec = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const total = Math.round(sec);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return String(minutes) + ':' + String(seconds).padStart(2, '0');
}

function updateVirtualControls() {
  if (previewMode !== 'source') return;
  const dur = virtualDurationSec();
  const cur = sourceMsToVirtualSec(vid.currentTime * 1000);
  virtualScrubber.value = dur > 0 ? Math.round(clamp(cur / dur, 0, 1) * 1000) : 0;
  virtualTime.textContent = fmtClock(cur) + ' / ' + fmtClock(dur);
  virtualPlayBtn.textContent = vid.paused ? '▶' : '❚❚';
  virtualPlayBtn.setAttribute('aria-label', vid.paused ? 'Play preview' : 'Pause preview');
}

function seekVirtualSec(sec) {
  if (!clips.length) return;
  vid.currentTime = virtualSecToSourceMs(clamp(sec, 0, virtualDurationSec())) / 1000;
  applyPreviewPlaybackRate();
  updateVirtualControls();
  renderPlayhead();
  updateClipActionButtons();
}

function playKeptPreview() {
  if (!clips.length) return;
  const ms = vid.currentTime * 1000;
  const lastEnd = clips[clips.length - 1].end;
  if (findClipIndexAt(ms) === -1 || ms >= lastEnd - 80) {
    const next = nextClipIndexAfter(ms);
    vid.currentTime = (next >= 0 ? clips[next].start : clips[0].start) / 1000;
  }
  applyPreviewPlaybackRate();
  vid.play().catch(() => {});
}

virtualPlayBtn.addEventListener('click', () => {
  if (vid.paused) playKeptPreview();
  else vid.pause();
  updateVirtualControls();
});

virtualScrubber.addEventListener('input', () => {
  const dur = virtualDurationSec();
  seekVirtualSec((Number(virtualScrubber.value) / 1000) * dur);
});

function applyPreviewPlaybackRate() {
  if (previewMode !== 'source') {
    vid.playbackRate = 1;
    return;
  }
  const idx = findClipIndexAt(vid.currentTime * 1000);
  vid.playbackRate = idx >= 0 ? Math.max(0.1, clipSpeed(clips[idx])) : 1;
}

function handleVideoTime() {
  if (previewMode === 'source') {
    const ms = vid.currentTime * 1000;
    if (clips.length && !dragState) {
      const idx = findClipIndexAt(ms);
      if (idx === -1 && !vid.paused) {
        const next = nextClipIndexAfter(ms);
        if (next >= 0) {
          vid.currentTime = clips[next].start / 1000;
          return;
        }
        vid.pause();
      } else if (idx >= 0 && !vid.paused && ms >= clips[idx].end - 60) {
        if (idx + 1 < clips.length) {
          vid.currentTime = clips[idx + 1].start / 1000;
          return;
        }
        vid.pause();
      }
    }
  }
  applyPreviewPlaybackRate();
  updateVirtualControls();
  renderPlayhead();
  updateClipActionButtons();
}

vid.addEventListener('timeupdate', handleVideoTime);
vid.addEventListener('seeked', handleVideoTime);
vid.addEventListener('play', applyPreviewPlaybackRate);
vid.addEventListener('play', updateVirtualControls);
vid.addEventListener('pause', updateVirtualControls);

// ── Global speed ─────────────────────────────────────────────────────────────
function setGlobalSpeed(v, save = true) {
  v = Math.round(v * 20) / 20;
  globalSpeed = clamp(v, SPEED_MIN, SPEED_MAX);
  gSlider.value = globalSpeed;
  gSpeedNum.innerHTML = fmtSpeed(globalSpeed);
  document.querySelectorAll('#gPresets .preset').forEach(b =>
    b.classList.toggle('active', +b.dataset.v === globalSpeed));
  if (save) fetch('/config', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ playbackSpeed: globalSpeed }) });
  refreshLengthUI();
  applyPreviewPlaybackRate();
  updateClipDetail();
}

gSlider.addEventListener('input', () => setGlobalSpeed(+gSlider.value));
document.querySelectorAll('#gPresets .preset').forEach(b =>
  b.addEventListener('click', () => setGlobalSpeed(+b.dataset.v)));

// ── Render quality ────────────────────────────────────────────────────────────
let renderQuality = 'draft';
function setRenderQuality(q, save = true) {
  renderQuality = ['draft', 'standard', 'final'].includes(q) ? q : 'draft';
  document.querySelectorAll('#qualityPresets .preset').forEach(b =>
    b.classList.toggle('active', b.dataset.q === renderQuality));
  if (save) fetch('/config', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ renderQuality }) });
}
document.querySelectorAll('#qualityPresets .preset').forEach(b =>
  b.addEventListener('click', () => setRenderQuality(b.dataset.q)));

// ── Target duration ↔ speed ─────────────────────────────────────────────────
function outputLengthAt(spd) {
  return clips.reduce((sec, c) => {
    const s = Number.isFinite(c.speed) ? c.speed : spd;
    return sec + (c.end - c.start) / 1000 / Math.max(0.1, s);
  }, 0);
}

function speedForLength(target) {
  let globalRaw = 0;
  let overrideSec = 0;
  clips.forEach(c => {
    if (Number.isFinite(c.speed)) overrideSec += (c.end - c.start) / 1000 / Math.max(0.1, c.speed);
    else globalRaw += (c.end - c.start) / 1000;
  });
  if (globalRaw <= 0) return null;
  const budget = target - overrideSec;
  if (budget <= 0) return SPEED_MAX;
  return globalRaw / budget;
}

function refreshLengthUI() {
  const len = outputLengthAt(globalSpeed);
  const rounded = Math.round(len * 10) / 10;
  if (document.activeElement !== lengthInput) lengthInput.value = rounded.toFixed(1);
  lengthSlider.value = Math.min(+lengthSlider.max, Math.max(+lengthSlider.min, len));

  const hasOverride = clips.some(c => Number.isFinite(c.speed));
  lengthHint.textContent = hasOverride ? 'Section speed overrides are included in this estimate.' : '';
  lengthHint.classList.remove('clamped');
  updateTimelineStats();
}

function applyTargetLength(target) {
  let spd = speedForLength(target);
  if (spd == null) return;
  const raw = spd;
  spd = Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.round(spd * 20) / 20));
  setGlobalSpeed(spd);
  const actual = outputLengthAt(spd);
  if (raw < SPEED_MIN || raw > SPEED_MAX) {
    lengthHint.textContent = 'Closest possible with the current speed range: ' + fmtSeconds(actual) + '.';
    lengthHint.classList.add('clamped');
  }
}

lengthSlider.addEventListener('input', () => applyTargetLength(+lengthSlider.value));
lengthInput.addEventListener('change', () => {
  const t = +lengthInput.value;
  if (Number.isFinite(t) && t > 0) applyTargetLength(t);
});

// ── Timeline rendering ──────────────────────────────────────────────────────
function renderTimeline() {
  const bar = document.getElementById('timelineBar');
  bar.innerHTML = '';

  let cursor = 0;
  clips.forEach(clip => {
    addDeadZone(bar, cursor, clip.start);
    cursor = Math.max(cursor, clip.end);
  });
  addDeadZone(bar, cursor, rawDuration);

  clips.forEach((clip, i) => {
    const lp = (clip.start / rawDuration) * 100;
    const wp = ((clip.end - clip.start) / rawDuration) * 100;
    const rawSec = fmtSeconds((clip.end - clip.start) / 1000);
    const outSec = fmtSeconds((clip.end - clip.start) / 1000 / Math.max(0.1, clipSpeed(clip)));
    const label = (clip.action || 'Section ' + (i + 1)).replace(/\\n/g, ' ');

    const el = document.createElement('div');
    el.className = 'clip-seg' + (i === selectedIdx ? ' selected' : '');
    el.dataset.clipIndex = i;
    el.style.left = clamp(lp, 0, 100) + '%';
    el.style.width = clamp(wp, 0, 100) + '%';
    el.title = 'Included section: ' + label;
    el.innerHTML =
      '<div class="handle handle-l" data-index="' + i + '" data-edge="start"></div>' +
      '<div class="clip-inner">' +
        '<span class="clip-name">' + escapeHtml(label) + '</span>' +
        '<span class="clip-dur">' + rawSec + ' source | ' + outSec + ' final</span>' +
      '</div>' +
      '<div class="handle handle-r" data-index="' + i + '" data-edge="end"></div>';
    bar.appendChild(el);
  });

  renderRuler();
  renderPlayhead();
  updateClipDetail();
  refreshLengthUI();
}

function addDeadZone(bar, start, end) {
  start = clamp(start, 0, rawDuration);
  end = clamp(end, 0, rawDuration);
  if (end <= start) return;
  const left = (start / rawDuration) * 100;
  const width = ((end - start) / rawDuration) * 100;
  const zone = document.createElement('div');
  zone.className = 'dead-zone';
  zone.style.left = left + '%';
  zone.style.width = width + '%';
  if (width > 7) zone.innerHTML = '<span class="dead-zone-label">cut</span>';
  bar.appendChild(zone);
}

function renderRuler() {
  const ruler = document.getElementById('ruler');
  ruler.innerHTML = '';
  if (!rawDuration) return;
  const totalSec = rawDuration / 1000;
  const step = totalSec < 10 ? 1 : totalSec < 30 ? 2 : totalSec < 60 ? 5 : 10;
  for (let s = 0; s <= totalSec; s += step) {
    const pct = (s / totalSec) * 100;
    const tick = document.createElement('div');
    tick.className = 'ruler-tick';
    tick.style.left = pct + '%';
    tick.innerHTML = '<div class="ruler-line"></div><div class="ruler-label">' + s + 's</div>';
    ruler.appendChild(tick);
  }
}

function renderPlayhead() {
  const bar = document.getElementById('timelineBar');
  const existing = document.getElementById('playhead');
  if (previewMode !== 'source') {
    if (existing) existing.remove();
    return;
  }
  const pct = clamp((vid.currentTime * 1000 / rawDuration) * 100, 0, 100);
  const playhead = existing || document.createElement('div');
  playhead.className = 'playhead';
  playhead.id = 'playhead';
  playhead.style.left = pct + '%';
  if (!existing) bar.appendChild(playhead);
}

function updateTimelineStats() {
  const includedMs = clips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0);
  const finalSec = outputLengthAt(globalSpeed);
  timelineStats.textContent = 'Source ' + fmtSeconds(rawDuration / 1000) + ' | Included ' +
    fmtSeconds(includedMs / 1000) + ' raw | Final ' + fmtSeconds(finalSec);
  durationReadout.textContent = 'Current final: ' + fmtSeconds(finalSec);
}

// ── Timeline interaction ────────────────────────────────────────────────────
document.getElementById('timelineBar').addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const bar = document.getElementById('timelineBar');
  const rect = bar.getBoundingClientRect();
  const clickedMs = clamp(((e.clientX - rect.left) / rect.width) * rawDuration, 0, rawDuration);
  const handle = e.target.closest('[data-edge]');

  if (handle) {
    e.preventDefault();
    const idx = +handle.dataset.index;
    const edge = handle.dataset.edge;
    dragState = { idx, edge, startX: e.clientX, rect, origVal: clips[idx][edge] };
    selectClip(idx);
    seekSourceMs(clips[idx][edge]);
    return;
  }

  const seg = e.target.closest('[data-clip-index]');
  selectClip(seg ? +seg.dataset.clipIndex : null);
  seekSourceMs(clickedMs);
});

document.addEventListener('mousemove', e => {
  if (!dragState) return;
  const { idx, edge, startX, rect, origVal } = dragState;
  const dx = e.clientX - startX;
  const msPerPx = rawDuration / rect.width;
  setClipEdge(idx, edge, Math.round(origVal + dx * msPerPx));
  if (previewMode === 'source') vid.currentTime = clips[idx][edge] / 1000;
  renderTimeline();
});

document.addEventListener('mouseup', () => {
  if (dragState) {
    saveClips();
    dragState = null;
    updateClipActionButtons();
  }
});

// ── Clip selection and edits ────────────────────────────────────────────────
function selectClip(idx) {
  selectedIdx = Number.isInteger(idx) && clips[idx] ? idx : null;
  renderTimeline();
}

function boundsForClip(idx) {
  return {
    lo: idx > 0 ? clips[idx - 1].end : 0,
    hi: idx < clips.length - 1 ? clips[idx + 1].start : rawDuration,
  };
}

function setClipRange(idx, start, end) {
  const bounds = boundsForClip(idx);
  if (bounds.hi - bounds.lo < MIN_CLIP_MS) {
    clips[idx].start = bounds.lo;
    clips[idx].end = bounds.hi;
    return;
  }
  let s = clamp(Math.round(start), bounds.lo, bounds.hi - MIN_CLIP_MS);
  let e = clamp(Math.round(end), s + MIN_CLIP_MS, bounds.hi);
  clips[idx].start = s;
  clips[idx].end = e;
}

function setClipEdge(idx, edge, value) {
  const clip = clips[idx];
  if (!clip) return;
  if (edge === 'start') setClipRange(idx, value, clip.end);
  else setClipRange(idx, clip.start, value);
}

function currentSourceMs() {
  if (previewMode !== 'source' || !Number.isFinite(vid.currentTime)) return null;
  return Math.round(vid.currentTime * 1000);
}

function splitPointForSelected() {
  if (selectedIdx === null || !clips[selectedIdx]) return null;
  const clip = clips[selectedIdx];
  const playhead = currentSourceMs();
  if (playhead !== null && playhead > clip.start + MIN_CLIP_MS && playhead < clip.end - MIN_CLIP_MS) {
    return { ms: playhead, fromPlayhead: true };
  }
  const mid = Math.round((clip.start + clip.end) / 2);
  if (mid - clip.start >= MIN_CLIP_MS && clip.end - mid >= MIN_CLIP_MS) {
    return { ms: mid, fromPlayhead: false };
  }
  return null;
}

function updateClipDetail() {
  const panel = document.getElementById('clipDetail');
  const empty = document.getElementById('emptyDetail');
  if (selectedIdx === null || !clips[selectedIdx]) {
    panel.classList.add('hidden');
    empty.classList.remove('hidden');
    updateClipActionButtons();
    return;
  }

  panel.classList.remove('hidden');
  empty.classList.add('hidden');
  const clip = clips[selectedIdx];
  const startS = +(clip.start / 1000).toFixed(2);
  const endS = +(clip.end / 1000).toFixed(2);
  const rawSec = (clip.end - clip.start) / 1000;
  const sp = clipSpeed(clip);

  document.getElementById('clipTitle').textContent = 'Section ' + (selectedIdx + 1) + ' of ' + clips.length;
  document.getElementById('clipAction').textContent = clip.action || 'Untitled included section';
  if (document.activeElement !== document.getElementById('clipStart')) document.getElementById('clipStart').value = startS;
  if (document.activeElement !== document.getElementById('clipEnd')) document.getElementById('clipEnd').value = endS;
  document.getElementById('clipRawDur').textContent = fmtSeconds(rawSec) + ' source';
  document.getElementById('rangeHint').textContent = clip.end > rawDuration
    ? 'This end point is past the source file (' + fmtSeconds(rawDuration / 1000) + '). Move it earlier before rendering.'
    : '';
  document.getElementById('clipOutDur').textContent = fmtSeconds(rawSec / Math.max(0.1, sp)) + ' at ' +
    (Math.round(sp * 100) / 100).toString() + 'x';

  const hasOverride = Number.isFinite(clip.speed);
  const toggle = document.getElementById('speedOverrideToggle');
  toggle.checked = hasOverride;
  document.getElementById('toggleLabel').textContent = hasOverride ? 'Custom speed for this section' : 'Uses global speed';
  document.getElementById('clipSlider').value = sp;
  document.getElementById('clipSpeedNum').innerHTML = fmtSpeed(sp);
  const row = document.getElementById('clipSpeedRow');
  row.style.opacity = hasOverride ? '1' : '.3';
  row.style.pointerEvents = hasOverride ? 'auto' : 'none';
  updateClipActionButtons();
}

function updateClipActionButtons() {
  const setStartBtn = document.getElementById('setStartBtn');
  const setEndBtn = document.getElementById('setEndBtn');
  const mergeBtn = document.getElementById('mergeBtn');
  const mergeAllBtn = document.getElementById('mergeAllBtn');
  const splitBtn = document.getElementById('splitBtn');
  const deleteBtn = document.getElementById('deleteBtn');
  const clip = selectedIdx === null ? null : clips[selectedIdx];
  const sourceMs = currentSourceMs();
  const canUsePlayhead = !!clip && sourceMs !== null;

  setStartBtn.disabled = !canUsePlayhead || sourceMs >= clip.end - MIN_CLIP_MS;
  setEndBtn.disabled = !canUsePlayhead || sourceMs <= clip.start + MIN_CLIP_MS;
  setStartBtn.title = canUsePlayhead ? 'Move this section start to the player position.' : 'Switch to Source trim to set this from the player position.';
  setEndBtn.title = canUsePlayhead ? 'Move this section end to the player position.' : 'Switch to Source trim to set this from the player position.';

  const split = splitPointForSelected();
  const mergeIdx = selectedMergePairIndex();
  mergeBtn.disabled = mergeIdx < 0;
  mergeBtn.textContent = mergeIdx === selectedIdx ? 'Merge with next' : mergeIdx === selectedIdx - 1 ? 'Merge with previous' : 'Merge adjacent';
  mergeBtn.title = mergeIdx >= 0
    ? 'Undo a split by joining this section with the touching neighbour.'
    : 'Only touching sections with the same speed can be merged.';
  mergeAllBtn.disabled = !hasMergeablePair();
  mergeAllBtn.title = hasMergeablePair()
    ? 'Join all touching sections that share the same speed.'
    : 'No touching same-speed sections to merge.';
  splitBtn.disabled = !split;
  splitBtn.textContent = split && split.fromPlayhead ? 'Split at playhead' : 'Split in middle';
  deleteBtn.disabled = !clip;
}

['clipStart', 'clipEnd'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    if (selectedIdx === null) return;
    const s = +document.getElementById('clipStart').value * 1000;
    const e = +document.getElementById('clipEnd').value * 1000;
    if (!Number.isFinite(s) || !Number.isFinite(e)) return;
    setClipRange(selectedIdx, s, e);
    saveClips();
    renderTimeline();
  });
});

document.getElementById('setStartBtn').addEventListener('click', () => {
  if (selectedIdx === null) return;
  const ms = currentSourceMs();
  if (ms === null) return;
  setClipEdge(selectedIdx, 'start', ms);
  saveClips();
  renderTimeline();
});

document.getElementById('setEndBtn').addEventListener('click', () => {
  if (selectedIdx === null) return;
  const ms = currentSourceMs();
  if (ms === null) return;
  setClipEdge(selectedIdx, 'end', ms);
  saveClips();
  renderTimeline();
});

document.getElementById('speedOverrideToggle').addEventListener('change', e => {
  if (selectedIdx === null) return;
  if (e.target.checked) clips[selectedIdx].speed = globalSpeed;
  else delete clips[selectedIdx].speed;
  saveClips();
  renderTimeline();
  applyPreviewPlaybackRate();
});

document.getElementById('clipSlider').addEventListener('input', e => {
  if (selectedIdx === null) return;
  const v = Math.round(+e.target.value * 20) / 20;
  clips[selectedIdx].speed = v;
  document.getElementById('clipSpeedNum').innerHTML = fmtSpeed(v);
  saveClips();
  renderTimeline();
  applyPreviewPlaybackRate();
});

document.getElementById('mergeBtn').addEventListener('click', () => {
  const idx = selectedMergePairIndex();
  if (idx < 0) return;
  mergePair(idx);
  saveClips();
  renderTimeline();
});

document.getElementById('mergeAllBtn').addEventListener('click', () => {
  let merged = false;
  for (let i = 0; i < clips.length - 1;) {
    if (mergePair(i)) {
      merged = true;
    } else {
      i++;
    }
  }
  if (!merged) return;
  saveClips();
  renderTimeline();
});

document.getElementById('splitBtn').addEventListener('click', () => {
  if (selectedIdx === null) return;
  const split = splitPointForSelected();
  if (!split) return;
  const clip = clips[selectedIdx];
  const second = { ...clip, start: split.ms };
  clip.end = split.ms;
  clips.splice(selectedIdx + 1, 0, second);
  selectedIdx += 1;
  saveClips();
  renderTimeline();
});

document.getElementById('deleteBtn').addEventListener('click', () => {
  if (selectedIdx === null) return;
  clips.splice(selectedIdx, 1);
  selectedIdx = clips.length ? Math.min(selectedIdx, clips.length - 1) : null;
  saveClips();
  renderTimeline();
});

// ── Save ────────────────────────────────────────────────────────────────────
function saveClips() {
  fetch('/clips', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(clips) });
}

// ── Render ──────────────────────────────────────────────────────────────────
document.getElementById('renderBtn').addEventListener('click', () => {
  document.getElementById('log').textContent = '';
  document.getElementById('log').classList.add('on');
  renderStatus.textContent = 'Rendering...';
  renderStatus.style.color = 'var(--muted)';
  document.getElementById('spinner').classList.add('on');
  document.getElementById('renderBtn').disabled = true;
  fetch('/render', { method:'POST' });
});

const es = new EventSource('/events');
es.addEventListener('render-log', e => {
  const log = document.getElementById('log');
  log.textContent += JSON.parse(e.data).text;
  log.scrollTop = log.scrollHeight;
});
es.addEventListener('render-done', e => {
  const { success } = JSON.parse(e.data);
  document.getElementById('spinner').classList.remove('on');
  renderStatus.textContent = success ? 'Done - preview refreshed' : 'Render failed';
  renderStatus.style.color = success ? 'var(--ok)' : 'var(--accent)';
  document.getElementById('renderBtn').disabled = false;
  if (success) {
    renderedBust = '?t=' + Date.now();
    setTimeout(() => {
      vid.dataset.mode = '';
      setPreviewMode('rendered');
      vid.play().catch(() => {});
    }, 800);
  }
});
</script>
</body>
</html>`;

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }

  if (pathname === '/video')     return serveFile(req, res, VIDEO_PATH, 'video/mp4');
  if (pathname === '/raw-video') return serveFile(req, res, RAW_PATH, 'video/mp4');

  if (pathname === '/config' && method === 'GET') {
    const plan = readPlan();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      playbackSpeed: plan.meta?.playbackSpeed ?? 1,
      renderQuality: plan.meta?.renderQuality ?? 'draft',
    }));
  }

  if (pathname === '/config' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const plan = readPlan();
        plan.meta = plan.meta || {};
        Object.assign(plan.meta, JSON.parse(body));
        writePlan(plan);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(e.message); }
    });
    return;
  }

  if (pathname === '/clips' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(readClips()));
  }

  if (pathname === '/clips' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        writeClips(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(e.message); }
    });
    return;
  }

  if (pathname === '/video-info' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ durationMs: getRawDuration() }));
  }

  if (pathname === '/render' && method === 'POST') {
    startRender();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Preview → http://${HOST}:${PORT}\n`);
});
