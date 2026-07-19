import { NextRequest, NextResponse } from 'next/server';
import { getProject, getTake, previewProps } from '@/server/service';

/** DemoVideoProps for the @remotion/player, using the project's active (or given) take. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const takeId = request.nextUrl.searchParams.get('takeId') ?? project.activeTakeId;
  if (!takeId) return NextResponse.json({ error: 'no take yet' }, { status: 404 });
  const take = getTake(takeId);
  if (!take || take.projectId !== id) return NextResponse.json({ error: 'take not found' }, { status: 404 });

  return NextResponse.json({ props: previewProps(project, take), takeId });
}
