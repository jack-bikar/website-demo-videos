import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { and, asc, eq } from 'drizzle-orm';
import { spawnSync } from 'node:child_process';
import { jobs, newId, nowIso, projects, renders, takes } from '@wdv/db';
import { renderOutputPath } from '@wdv/engine/paths';
import { progressEventSchema, type Clip } from '@wdv/schema';

/** Local ffprobe helper — the Next server must never import the render/capture stack
 *  (it pulls @remotion/bundler + puppeteer into the web bundle); heavy work stays in
 *  the stage child processes. */
function getVideoDurationMs(file: string): number {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { encoding: 'utf8' },
  );
  const seconds = Number.parseFloat((result.stdout || '').trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}
import { createTake, dataDir, db, effectiveClips, getProject, getTake, planFromProject, takePathsFor } from './service';

/**
 * In-process job runner: claims queued jobs from SQLite (better-sqlite3 is synchronous,
 * so a single UPDATE is race-free), spawns pipeline stages as tsx child processes, parses
 * their NDJSON stdout into progress updates, and fans events out over an EventEmitter for
 * SSE. Concurrency 1 — Chrome + ffmpeg + Remotion each already saturate the machine.
 */

export type JobRow = typeof jobs.$inferSelect;

interface Runner {
  events: EventEmitter;
  enqueue: (input: EnqueueInput) => JobRow;
  cancel: (jobId: string) => boolean;
}

export interface EnqueueInput {
  type: 'pipeline' | 'render' | 'derive';
  projectId: string;
  takeId?: string;
  options?: { quality?: string; mode?: string };
}

const REPO_ROOT = path.resolve(process.cwd(), '..', '..');
const STAGE_SCRIPT = path.join(REPO_ROOT, 'packages', 'cli', 'src', 'stage.ts');

function createRunner(): Runner {
  const events = new EventEmitter();
  events.setMaxListeners(100);
  let current: { jobId: string; child: ChildProcess } | null = null;

  // Boot recovery: anything still "running" was orphaned by a dev-server restart.
  db.update(jobs)
    .set({ status: 'failed', error: 'orphaned by restart', finishedAt: nowIso() })
    .where(eq(jobs.status, 'running'))
    .run();

  const update = (jobId: string, patch: Partial<typeof jobs.$inferInsert>) => {
    db.update(jobs).set(patch).where(eq(jobs.id, jobId)).run();
    const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (row) events.emit('job', row);
  };

  const pump = () => {
    if (current) return;
    const next = db
      .select()
      .from(jobs)
      .where(eq(jobs.status, 'queued'))
      .orderBy(asc(jobs.createdAt))
      .limit(1)
      .get();
    if (!next) return;
    start(next);
  };

  const start = (job: JobRow) => {
    const project = getProject(job.projectId);
    if (!project) {
      update(job.id, { status: 'failed', error: 'project not found', finishedAt: nowIso() });
      return pump();
    }
    const take = job.takeId ? getTake(job.takeId) : undefined;
    if (!take) {
      update(job.id, { status: 'failed', error: 'take not found', finishedAt: nowIso() });
      return pump();
    }

    const plan = JSON.parse(take.planSnapshotJson);
    const paths = takePathsFor(project, take.id);
    fs.mkdirSync(paths.root, { recursive: true });

    const input: Record<string, unknown> = { plan, take: paths, chromeSearchRoot: REPO_ROOT };
    const options = JSON.parse(job.inputJson ?? '{}');
    let renderId: string | null = null;
    if (job.type === 'render') {
      renderId = newId();
      input.outputPath = renderOutputPath(dataDir, project.id, renderId);
      input.quality = options.quality ?? 'draft';
      input.mode = options.mode ?? 'auto';
      const override: Clip[] | null = take.clipsOverrideJson ? effectiveClips(project, take) : null;
      input.clipsOverride = override;
    }

    const inputFile = path.join(os.tmpdir(), `wdv-job-${job.id}.json`);
    fs.writeFileSync(inputFile, JSON.stringify(input));
    const logPath = path.join(paths.root, `job-${job.id}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const child = spawn(process.execPath, ['--import', 'tsx', STAGE_SCRIPT, job.type, '--input', inputFile], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    current = { jobId: job.id, child };
    update(job.id, { status: 'running', pid: child.pid ?? null, logPath, startedAt: nowIso() });

    let resultData: Record<string, unknown> | null = null;
    let stdoutBuf = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        logStream.write(line + '\n');
        try {
          const event = progressEventSchema.parse(JSON.parse(line));
          if (event.type === 'progress') {
            update(job.id, { progress: event.value, message: event.message ?? null });
          } else if (event.type === 'result') {
            resultData = event.data;
          } else if (event.type === 'log') {
            update(job.id, { message: event.message });
          }
        } catch {
          /* raw log line (ffmpeg/Remotion output) — file log only */
        }
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => logStream.write(chunk));

    child.on('exit', (code, signal) => {
      logStream.end();
      fs.rmSync(inputFile, { force: true });
      const canceled = signal === 'SIGTERM';
      if (code === 0) {
        finishSuccess(job, take.id, renderId, resultData, options);
      } else {
        update(job.id, {
          status: canceled ? 'canceled' : 'failed',
          error: canceled ? null : `exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
          finishedAt: nowIso(),
        });
        if (job.type === 'pipeline') {
          db.update(takes).set({ status: 'failed' }).where(eq(takes.id, take.id)).run();
        }
      }
      current = null;
      pump();
    });
  };

  const finishSuccess = (
    job: JobRow,
    takeId: string,
    renderId: string | null,
    resultData: Record<string, unknown> | null,
    options: Record<string, unknown>,
  ) => {
    update(job.id, {
      status: 'succeeded',
      progress: 1,
      outputJson: resultData ? JSON.stringify(resultData) : null,
      finishedAt: nowIso(),
    });
    if (job.type === 'pipeline') {
      db.update(takes)
        .set({ status: 'processed', durationMs: Number(resultData?.durationMs) || null })
        .where(eq(takes.id, takeId))
        .run();
      // Make the fresh take the project's active one.
      db.update(projects).set({ activeTakeId: takeId, updatedAt: nowIso() }).where(eq(projects.id, job.projectId)).run();
    }
    if (job.type === 'render' && renderId) {
      const outputPath = renderOutputPath(dataDir, job.projectId, renderId);
      db.insert(renders)
        .values({
          id: renderId,
          projectId: job.projectId,
          takeId,
          jobId: job.id,
          mode: String(resultData?.mode ?? 'fast'),
          quality: String(options.quality ?? 'draft'),
          outputPath,
          durationMs: fs.existsSync(outputPath) ? getVideoDurationMs(outputPath) : null,
          createdAt: nowIso(),
        })
        .run();
    }
  };

  const enqueue = (input: EnqueueInput): JobRow => {
    const project = getProject(input.projectId);
    if (!project) throw new Error('Project not found');

    let takeId = input.takeId;
    if (input.type === 'pipeline') {
      const take = createTake(project, planFromProject(project));
      takeId = take.id;
    }
    if (!takeId) {
      takeId = project.activeTakeId ?? undefined;
    }
    if (!takeId) throw new Error('No take available — record first.');

    const id = newId();
    db.insert(jobs)
      .values({
        id,
        type: input.type,
        status: 'queued',
        projectId: input.projectId,
        takeId,
        inputJson: JSON.stringify(input.options ?? {}),
        createdAt: nowIso(),
      })
      .run();
    const row = db.select().from(jobs).where(eq(jobs.id, id)).get()!;
    events.emit('job', row);
    queueMicrotask(pump);
    return row;
  };

  const cancel = (jobId: string): boolean => {
    if (current?.jobId === jobId) {
      current.child.kill('SIGTERM');
      return true;
    }
    const row = db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued'))).get();
    if (row) {
      update(jobId, { status: 'canceled', finishedAt: nowIso() });
      return true;
    }
    return false;
  };

  return { events, enqueue, cancel };
}

const globalForRunner = globalThis as unknown as { __wdvJobRunner?: Runner };

export function getJobRunner(): Runner {
  globalForRunner.__wdvJobRunner ??= createRunner();
  return globalForRunner.__wdvJobRunner;
}

export function getJob(id: string): JobRow | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}
