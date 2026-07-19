import { z } from 'zod';

/** Job lifecycle shared by the studio job runner and the CLI stage processes. */

export const jobTypeSchema = z.enum(['capture', 'smooth', 'trim', 'keyframes', 'pipeline', 'render', 'screenshots']);
export type JobType = z.infer<typeof jobTypeSchema>;

export const jobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/**
 * NDJSON protocol emitted on stdout by stage child processes, one JSON object per line.
 * Anything that doesn't parse as one of these is treated as a plain log line.
 */
/** Shared context every long-running stage receives from its caller (CLI or job runner). */
export interface StageContext {
  log: (line: string) => void;
  warn: (line: string) => void;
  onProgress?: (progress: { value: number; message: string }) => void;
  signal?: AbortSignal;
}

export const consoleStageContext: StageContext = {
  log: (line) => console.log(line),
  warn: (line) => console.warn(line),
};

export const progressEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), value: z.number().min(0).max(1), message: z.string().optional() }).strict(),
  z.object({ type: z.literal('log'), level: z.enum(['info', 'warn', 'error']).default('info'), message: z.string() }).strict(),
  z.object({ type: z.literal('result'), data: z.record(z.unknown()) }).strict(),
]);
export type ProgressEvent = z.infer<typeof progressEventSchema>;
