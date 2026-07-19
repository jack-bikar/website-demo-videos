import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * SQLite schema, kept Postgres-portable for the SaaS path: UUID text PKs, ISO-8601
 * timestamp strings, JSON as text columns (→ jsonb later). DB rows hold editable
 * intent + small state; video artifacts live on disk under data/projects/.
 *
 * V1 is walkthrough-only with one implicit scene per project, so steps/meta live on
 * the project row; the polymorphic scenes table arrives with the second mode.
 */

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  viewportW: integer('viewport_w').notNull().default(1280),
  viewportH: integer('viewport_h').notNull().default(800),
  /** Step[] driving the walkthrough capture. */
  stepsJson: text('steps_json').notNull().default('[]'),
  /** PlanMeta (playbackSpeed, captions, zoom, overlay, trim tunables…). */
  metaJson: text('meta_json').notNull().default('{}'),
  /** RecordingConfig (mode/connectUrl/headful/chromePath/userDataDir…). */
  recordingJson: text('recording_json').notNull().default('{}'),
  hideTextJson: text('hide_text_json').notNull().default('[]'),
  /** The take whose artifacts the studio previews/renders. */
  activeTakeId: text('active_take_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const takes = sqliteTable('takes', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'), // pending | recorded | processed | failed
  durationMs: integer('duration_ms'),
  /** Exact BrowsePlan sent to the recorder — reproducibility. */
  planSnapshotJson: text('plan_snapshot_json').notNull(),
  /** Manual cut edits (Clip[]); null = use the derived clips.json artifact. */
  clipsOverrideJson: text('clips_override_json'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
});

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(), // capture | smooth | derive | pipeline | render | screenshots
  status: text('status').notNull().default('queued'), // queued | running | succeeded | failed | canceled
  projectId: text('project_id').notNull(),
  takeId: text('take_id'),
  inputJson: text('input_json').notNull().default('{}'),
  outputJson: text('output_json'),
  progress: real('progress').notNull().default(0),
  message: text('message'),
  pid: integer('pid'),
  logPath: text('log_path'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
});

export const renders = sqliteTable('renders', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  takeId: text('take_id').notNull(),
  jobId: text('job_id'),
  mode: text('mode').notNull(), // fast | full
  quality: text('quality').notNull(),
  outputPath: text('output_path').notNull(),
  durationMs: integer('duration_ms'),
  createdAt: text('created_at').notNull(),
});
