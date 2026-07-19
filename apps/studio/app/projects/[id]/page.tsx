import StudioClient from '@/components/StudioClient';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudioClient projectId={id} />;
}
