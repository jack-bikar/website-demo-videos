import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, newId, nowIso, projects, renders, takes, type Db } from '@wdv/db';
import { takePaths, type TakePaths } from '@wdv/engine/paths';
import {
  browsePlanSchema,
  clipsSchema,
  planMetaSchema,
  recordingConfigSchema,
  stepSchema,
  z,
  type BrowsePlan,
  type Clip,
  type DemoVideoProps,
} from './zod';
import { resolveDataDir } from '@wdv/db';

export const db: Db = getDb();
export const dataDir = resolveDataDir();

export type ProjectRow = typeof projects.$inferSelect;
export type TakeRow = typeof takes.$inferSelect;

export const projectInputSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).default({ width: 1920, height: 1080 }),
  steps: z.array(stepSchema).default([]),
  meta: planMetaSchema.default({}),
  recording: recordingConfigSchema.default({}),
  hideText: z.array(z.string()).default([]),
});
export type ProjectInput = z.infer<typeof projectInputSchema>;

export function getProject(id: string): ProjectRow | undefined {
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

export function getTake(id: string): TakeRow | undefined {
  return db.select().from(takes).where(eq(takes.id, id)).get();
}

/** Build the BrowsePlan a capture/render uses from the project row's editable fields. */
export function planFromProject(project: ProjectRow): BrowsePlan {
  return browsePlanSchema.parse({
    url: project.url,
    viewport: { width: project.viewportW, height: project.viewportH },
    hideText: JSON.parse(project.hideTextJson),
    recording: JSON.parse(project.recordingJson),
    meta: JSON.parse(project.metaJson),
    steps: JSON.parse(project.stepsJson),
  });
}

export function takePathsFor(project: ProjectRow, takeId: string): TakePaths {
  return takePaths(dataDir, project.id, takeId);
}

/** Manual override from the studio wins; otherwise the derived clips.json artifact. */
export function effectiveClips(project: ProjectRow, take: TakeRow): Clip[] {
  if (take.clipsOverrideJson) {
    return clipsSchema.parse(JSON.parse(take.clipsOverrideJson));
  }
  const paths = takePathsFor(project, take.id);
  if (fs.existsSync(paths.clips)) {
    return clipsSchema.parse(JSON.parse(fs.readFileSync(paths.clips, 'utf8')));
  }
  return [];
}

/** Props for the @remotion/player preview; videoSrc points at the Range-streaming route. */
export function previewProps(project: ProjectRow, take: TakeRow): DemoVideoProps {
  const paths = takePathsFor(project, take.id);
  const keyframes = fs.existsSync(paths.keyframes) ? JSON.parse(fs.readFileSync(paths.keyframes, 'utf8')) : [];
  return {
    videoSrc: `/api/projects/${project.id}/takes/${take.id}/video`,
    viewport: { width: project.viewportW, height: project.viewportH },
    clips: effectiveClips(project, take),
    keyframes,
    meta: JSON.parse(project.metaJson),
  };
}

export function createProject(input: ProjectInput): ProjectRow {
  const id = newId();
  const now = nowIso();
  db.insert(projects)
    .values({
      id,
      name: input.name,
      url: input.url,
      viewportW: input.viewport.width,
      viewportH: input.viewport.height,
      stepsJson: JSON.stringify(input.steps, null, 2),
      metaJson: JSON.stringify(input.meta, null, 2),
      recordingJson: JSON.stringify(input.recording, null, 2),
      hideTextJson: JSON.stringify(input.hideText),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getProject(id)!;
}

export function createTake(project: ProjectRow, plan: BrowsePlan): TakeRow {
  const id = newId();
  db.insert(takes)
    .values({
      id,
      projectId: project.id,
      status: 'pending',
      planSnapshotJson: JSON.stringify(plan),
      createdAt: nowIso(),
    })
    .run();
  return getTake(id)!;
}

export function listTakes(projectId: string): TakeRow[] {
  return db.select().from(takes).where(eq(takes.projectId, projectId)).all().reverse();
}

export function listRenders(projectId: string) {
  return db.select().from(renders).where(eq(renders.projectId, projectId)).all().reverse();
}

/** Default steps for a brand-new project: a simple scroll tour of the page. */
export function defaultSteps(url: string) {
  return [
    { type: 'navigate', target: url, waitUntil: 'networkidle2', silent: true, why: 'Load the page' },
    { type: 'wait', ms: 400, why: 'Hold on the hero' },
    { type: 'scroll', deltaY: 6000, ms: 6000, linear: true, why: 'Tour the page top to bottom' },
  ];
}
