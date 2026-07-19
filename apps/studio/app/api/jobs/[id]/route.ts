import { NextRequest, NextResponse } from 'next/server';
import { getJob, getJobRunner } from '@/server/jobs';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(job);
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const canceled = getJobRunner().cancel(id);
  return NextResponse.json({ canceled });
}
