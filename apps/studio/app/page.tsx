'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface ProjectRow {
  id: string;
  name: string;
  url: string;
  viewportW: number;
  viewportH: number;
  activeTakeId: string | null;
  updatedAt: string;
}

export default function ProjectListPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then(setProjects)
      .catch(() => setError('Failed to load projects'));
  }, []);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || new URL(url).hostname, url }),
      });
      if (!res.ok) throw new Error((await res.json()).error?.formErrors?.join(', ') || 'Create failed');
      const project = await res.json();
      router.push(`/projects/${project.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container grid" style={{ gridTemplateColumns: '340px 1fr', alignItems: 'start' }}>
      <div className="card">
        <h2>New project</h2>
        <p className="muted small">Paste a URL — you get a scroll-tour plan to refine into a full walkthrough.</p>
        <div className="field">
          <label>Website URL</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
        </div>
        <div className="field">
          <label>Name (optional)</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My product demo" />
        </div>
        {error ? <p className="small" style={{ color: 'var(--bad)' }}>{error}</p> : null}
        <button onClick={create} disabled={busy || !url}>
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </div>

      <div className="grid">
        {projects.length === 0 ? (
          <div className="card muted">No projects yet — create one to get started.</div>
        ) : (
          projects.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="card row spread" style={{ color: 'inherit' }}>
              <div>
                <strong>{p.name}</strong>
                <div className="muted small">{p.url}</div>
              </div>
              <div className="row">
                <span className="badge">{p.viewportW}×{p.viewportH}</span>
                {p.activeTakeId ? <span className="badge processed">recorded</span> : <span className="badge">empty</span>}
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
