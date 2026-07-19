import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getJobRunner } from '@/server/jobs';

const enqueueSchema = z.object({
  type: z.enum(['pipeline', 'render', 'derive']),
  takeId: z.string().optional(),
  options: z
    .object({
      quality: z.enum(['draft', 'standard', 'final']).optional(),
      mode: z.enum(['auto', 'fast', 'full']).optional(),
    })
    .optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = enqueueSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const job = getJobRunner().enqueue({ ...parsed.data, projectId: id });
    return NextResponse.json(job, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
