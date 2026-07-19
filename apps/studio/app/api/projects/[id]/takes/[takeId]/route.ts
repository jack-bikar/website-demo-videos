import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { takes } from '@wdv/db';
import { clipsSchema, z } from '@/server/zod';
import { db, getProject, getTake } from '@/server/service';

const patchSchema = z.object({
  /** Manual cut edits; null clears the override back to derived clips. */
  clipsOverride: clipsSchema.nullable(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; takeId: string }> }) {
  const { id, takeId } = await params;
  const project = getProject(id);
  const take = getTake(takeId);
  if (!project || !take || take.projectId !== id) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  db.update(takes)
    .set({ clipsOverrideJson: parsed.data.clipsOverride ? JSON.stringify(parsed.data.clipsOverride) : null })
    .where(eq(takes.id, takeId))
    .run();
  return NextResponse.json(getTake(takeId));
}
