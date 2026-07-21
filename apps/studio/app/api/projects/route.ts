import { NextRequest, NextResponse } from 'next/server';
import { projects } from '@wdv/db';
import { createProject, db, defaultMeta, defaultSteps, projectInputSchema } from '@/server/service';

export function GET() {
  const rows = db.select().from(projects).all().reverse();
  return NextResponse.json(rows);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  // A bare { name, url } gets a sensible scroll-tour plan to start from.
  if (!body.steps?.length && body.url) {
    body.steps = defaultSteps(body.url);
  }
  if (!body.meta) {
    body.meta = defaultMeta();
  }
  const parsed = projectInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const project = createProject(parsed.data);
  return NextResponse.json(project, { status: 201 });
}
