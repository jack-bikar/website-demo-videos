import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { nowIso, projects } from '@wdv/db';
import { projectRoot } from '@wdv/engine/paths';
import { dataDir, db, getProject, listRenders, listTakes, projectInputSchema } from '@/server/service';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ project, takes: listTakes(id), renders: listRenders(id) });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const parsed = projectInputSchema.partial().safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const input = parsed.data;
  db.update(projects)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.url !== undefined && { url: input.url }),
      ...(input.viewport !== undefined && { viewportW: input.viewport.width, viewportH: input.viewport.height }),
      ...(input.steps !== undefined && { stepsJson: JSON.stringify(input.steps, null, 2) }),
      ...(input.meta !== undefined && { metaJson: JSON.stringify(input.meta, null, 2) }),
      ...(input.recording !== undefined && { recordingJson: JSON.stringify(input.recording, null, 2) }),
      ...(input.hideText !== undefined && { hideTextJson: JSON.stringify(input.hideText) }),
      updatedAt: nowIso(),
    })
    .where(eq(projects.id, id))
    .run();
  return NextResponse.json(getProject(id));
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  db.delete(projects).where(eq(projects.id, id)).run();
  fs.rmSync(projectRoot(dataDir, id), { recursive: true, force: true });
  return NextResponse.json({ ok: true });
}
