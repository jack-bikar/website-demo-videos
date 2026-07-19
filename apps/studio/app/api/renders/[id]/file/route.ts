import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { renders } from '@wdv/db';
import { db, getProject } from '@/server/service';
import { streamVideo } from '@/server/stream';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const render = db.select().from(renders).where(eq(renders.id, id)).get();
  if (!render) return Response.json({ error: 'not found' }, { status: 404 });
  const project = getProject(render.projectId);
  const name = `${(project?.name ?? 'demo').replace(/[^\w-]+/g, '-')}-${render.quality}.mp4`;
  const download = request.nextUrl.searchParams.has('download') ? name : undefined;
  return streamVideo(render.outputPath, request.headers.get('range'), download);
}
