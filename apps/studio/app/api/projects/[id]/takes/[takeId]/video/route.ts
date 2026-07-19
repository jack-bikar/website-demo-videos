import fs from 'node:fs';
import { NextRequest } from 'next/server';
import { getProject, getTake, takePathsFor } from '@/server/service';
import { streamVideo } from '@/server/stream';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; takeId: string }> }) {
  const { id, takeId } = await params;
  const project = getProject(id);
  const take = getTake(takeId);
  if (!project || !take || take.projectId !== id) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  const paths = takePathsFor(project, takeId);
  const file = fs.existsSync(paths.smoothMp4) ? paths.smoothMp4 : paths.rawMp4;
  return streamVideo(file, request.headers.get('range'));
}
