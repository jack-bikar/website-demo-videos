import fs from 'node:fs';
import { Readable } from 'node:stream';

/**
 * Range-request MP4 streaming (ported from the legacy preview-server's serveFile).
 * The Player scrubs by seeking, which needs 206 partial responses.
 */
export function streamVideo(filePath: string, rangeHeader: string | null, download?: string): Response {
  if (!fs.existsSync(filePath)) {
    return Response.json({ error: 'video not found' }, { status: 404 });
  }
  const { size } = fs.statSync(filePath);
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    ...(download ? { 'Content-Disposition': `attachment; filename="${download}"` } : {}),
  };

  const match = rangeHeader?.match(/bytes=(\d*)-(\d*)/);
  if (match && (match[1] || match[2])) {
    const start = match[1] ? parseInt(match[1], 10) : Math.max(0, size - parseInt(match[2], 10));
    const end = match[1] && match[2] ? Math.min(parseInt(match[2], 10), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      },
    });
  }

  const stream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(size) } });
}
