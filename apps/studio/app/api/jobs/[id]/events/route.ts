import { NextRequest } from 'next/server';
import { getJob, getJobRunner, type JobRow } from '@/server/jobs';

export const dynamic = 'force-dynamic';

/** SSE stream of one job's lifecycle: current row immediately, updates as they land,
 *  heartbeat every 15s, closes on a terminal status or client disconnect. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runner = getJobRunner();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (row: JobRow) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(row)}\n\n`));
        if (['succeeded', 'failed', 'canceled'].includes(row.status)) {
          cleanup();
          controller.close();
        }
      };
      const onJob = (row: JobRow) => {
        if (row.id === id) send(row);
      };
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), 15000);
      const cleanup = () => {
        clearInterval(heartbeat);
        runner.events.off('job', onJob);
      };

      runner.events.on('job', onJob);
      request.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });

      const current = getJob(id);
      if (current) send(current);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
