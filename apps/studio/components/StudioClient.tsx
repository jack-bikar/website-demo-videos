'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { Clip, DemoVideoProps } from '@wdv/schema';

const PlayerPreview = dynamic(() => import('./PlayerPreview'), { ssr: false });

interface ProjectRow {
  id: string;
  name: string;
  url: string;
  viewportW: number;
  viewportH: number;
  stepsJson: string;
  metaJson: string;
  recordingJson: string;
  activeTakeId: string | null;
}
interface TakeRow {
  id: string;
  status: string;
  durationMs: number | null;
  clipsOverrideJson: string | null;
  createdAt: string;
}
interface RenderRow {
  id: string;
  mode: string;
  quality: string;
  durationMs: number | null;
  createdAt: string;
}
interface JobRow {
  id: string;
  type: string;
  status: string;
  progress: number;
  message: string | null;
  error: string | null;
}

export default function StudioClient({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<ProjectRow | null>(null);
  const [takes, setTakes] = useState<TakeRow[]>([]);
  const [renders, setRenders] = useState<RenderRow[]>([]);
  const [previewData, setPreviewData] = useState<{ props: DemoVideoProps; takeId: string } | null>(null);
  const [stepsText, setStepsText] = useState('');
  const [metaText, setMetaText] = useState('');
  const [job, setJob] = useState<JobRow | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [dirtyClips, setDirtyClips] = useState(false);
  const [quality, setQuality] = useState('draft');
  const [notice, setNotice] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}`);
    if (!res.ok) return;
    const data = await res.json();
    setProject(data.project);
    setTakes(data.takes);
    setRenders(data.renders);
    setStepsText((prev) => prev || JSON.stringify(JSON.parse(data.project.stepsJson), null, 2));
    setMetaText((prev) => prev || JSON.stringify(JSON.parse(data.project.metaJson), null, 2));

    const preview = await fetch(`/api/projects/${projectId}/preview`);
    if (preview.ok) {
      const p = await preview.json();
      setPreviewData(p);
      setClips(p.props.clips);
      setDirtyClips(false);
    }
  }, [projectId]);

  useEffect(() => {
    reload();
    return () => eventSourceRef.current?.close();
  }, [reload]);

  const watchJob = (jobId: string) => {
    eventSourceRef.current?.close();
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    eventSourceRef.current = es;
    es.onmessage = (e) => {
      const row: JobRow = JSON.parse(e.data);
      setJob(row);
      if (['succeeded', 'failed', 'canceled'].includes(row.status)) {
        es.close();
        reload();
      }
    };
    es.onerror = () => es.close();
  };

  const saveplan = async () => {
    setNotice(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps: JSON.parse(stepsText), meta: JSON.parse(metaText) }),
      });
      if (!res.ok) throw new Error('Validation failed — check the JSON against the step schema.');
      setNotice('Plan saved.');
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  const enqueue = async (type: string, options?: Record<string, string>) => {
    setNotice(null);
    const res = await fetch(`/api/projects/${projectId}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, options }),
    });
    if (!res.ok) {
      setNotice((await res.json()).error ?? 'Failed to start job');
      return;
    }
    const row = await res.json();
    setJob(row);
    watchJob(row.id);
  };

  const saveClips = async (next: Clip[] | null) => {
    if (!previewData) return;
    await fetch(`/api/projects/${projectId}/takes/${previewData.takeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipsOverride: next }),
    });
    await reload();
  };

  const updateClip = (index: number, patch: Partial<Clip>) => {
    setClips((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
    setDirtyClips(true);
  };

  if (!project) return <div className="container muted">Loading…</div>;

  const jobActive = job && ['queued', 'running'].includes(job.status);

  return (
    <div className="container grid" style={{ gridTemplateColumns: '380px 1fr', alignItems: 'start' }}>
      {/* Left: plan editing + actions */}
      <div className="grid">
        <div className="card">
          <div className="row spread">
            <h1>{project.name}</h1>
            <span className="badge">{project.viewportW}×{project.viewportH}</span>
          </div>
          <div className="muted small">{project.url}</div>
        </div>

        <div className="card">
          <h2>Steps</h2>
          <textarea
            className="code"
            rows={14}
            value={stepsText}
            onChange={(e) => setStepsText(e.target.value)}
            spellCheck={false}
          />
          <h2 style={{ marginTop: 14 }}>Meta</h2>
          <textarea
            className="code"
            rows={8}
            value={metaText}
            onChange={(e) => setMetaText(e.target.value)}
            spellCheck={false}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="secondary" onClick={saveplan}>Save plan</button>
            {notice ? <span className="small muted">{notice}</span> : null}
          </div>
        </div>

        <div className="card">
          <h2>Actions</h2>
          <div className="row wrap">
            <button onClick={() => enqueue('pipeline')} disabled={!!jobActive}>
              ● Record new take
            </button>
            <button className="secondary" onClick={() => enqueue('derive')} disabled={!!jobActive || !project.activeTakeId}>
              Re-derive cuts
            </button>
          </div>
          <div className="row wrap" style={{ marginTop: 10 }}>
            <select value={quality} onChange={(e) => setQuality(e.target.value)} style={{ width: 120 }}>
              <option value="draft">draft</option>
              <option value="standard">standard</option>
              <option value="final">final</option>
            </select>
            <button onClick={() => enqueue('render', { quality })} disabled={!!jobActive || !project.activeTakeId}>
              ⬒ Render MP4
            </button>
          </div>

          {job ? (
            <div style={{ marginTop: 14 }}>
              <div className="row spread small">
                <span>
                  {job.type} <span className={`badge ${job.status}`}>{job.status}</span>
                </span>
                {jobActive ? (
                  <button className="danger" onClick={() => fetch(`/api/jobs/${job.id}`, { method: 'DELETE' })}>
                    Cancel
                  </button>
                ) : null}
              </div>
              <div className="progress-track" style={{ marginTop: 6 }}>
                <div className="progress-fill" style={{ width: `${Math.round(job.progress * 100)}%` }} />
              </div>
              <div className="muted small" style={{ marginTop: 4 }}>{job.error ?? job.message ?? ''}</div>
            </div>
          ) : null}
        </div>

        <div className="card">
          <h2>Renders</h2>
          {renders.length === 0 ? (
            <div className="muted small">No renders yet.</div>
          ) : (
            renders.map((r) => (
              <div key={r.id} className="row spread" style={{ padding: '6px 0' }}>
                <span className="small">
                  {r.quality} <span className="muted">({r.mode}, {r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'})</span>
                </span>
                <a className="small" href={`/api/renders/${r.id}/file?download`} download>
                  Download
                </a>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right: preview + clip editor */}
      <div className="grid">
        {previewData ? (
          <PlayerPreview props={{ ...previewData.props, clips }} />
        ) : (
          <div className="card muted" style={{ minHeight: 220, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            Record a take to see the preview.
          </div>
        )}

        {previewData ? (
          <div className="card">
            <div className="row spread">
              <h2>Clips</h2>
              <div className="row">
                {dirtyClips ? (
                  <button onClick={() => saveClips(clips)}>Save cuts</button>
                ) : null}
                <button className="secondary" onClick={() => saveClips(null)}>
                  Reset to derived
                </button>
              </div>
            </div>
            <table className="clips">
              <thead>
                <tr>
                  <th>#</th><th>Start (ms)</th><th>End (ms)</th><th>Speed</th><th>Caption</th><th />
                </tr>
              </thead>
              <tbody>
                {clips.map((clip, i) => (
                  <tr key={i}>
                    <td className="muted">{i + 1}</td>
                    <td><input type="number" value={clip.start} onChange={(e) => updateClip(i, { start: Number(e.target.value) })} /></td>
                    <td><input type="number" value={clip.end} onChange={(e) => updateClip(i, { end: Number(e.target.value) })} /></td>
                    <td>
                      <input
                        type="number" step="0.1" value={clip.speed ?? ''}
                        placeholder="default"
                        onChange={(e) => updateClip(i, { speed: e.target.value ? Number(e.target.value) : undefined })}
                      />
                    </td>
                    <td style={{ minWidth: 180 }}>
                      <input value={clip.action} onChange={(e) => updateClip(i, { action: e.target.value })} />
                    </td>
                    <td>
                      <button
                        className="danger"
                        onClick={() => {
                          setClips((prev) => prev.filter((_, j) => j !== i));
                          setDirtyClips(true);
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="card">
          <h2>Takes</h2>
          {takes.length === 0 ? (
            <div className="muted small">No takes yet.</div>
          ) : (
            takes.map((t) => (
              <div key={t.id} className="row spread" style={{ padding: '6px 0' }}>
                <span className="small">
                  {new Date(t.createdAt).toLocaleString()}{' '}
                  {t.durationMs ? <span className="muted">{(t.durationMs / 1000).toFixed(1)}s</span> : null}{' '}
                  {project.activeTakeId === t.id ? <span className="badge processed">active</span> : null}
                </span>
                <span className={`badge ${t.status}`}>{t.status}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
