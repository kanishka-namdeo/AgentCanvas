// POST /api/sessions/[id]/attachments — persist a user message's image
//                                     attachments to the server DB
// GET  /api/sessions/[id]/attachments — list them (id, name, mimeType,
//                                     sizeBytes, dataUrl)
//
// Body (POST): { messageId: string, attachments: Array<{ id, name, dataUrl }> }
//
// The client's attachment pipeline (lib/agent/attachments.ts) already
// downscaled + re-encoded each image to a compact data URL (≤ ~1.1MB binary)
// before upload, so we store the base64 payload directly in SQLite. Rows are
// keyed by the CLIENT's attachment id (img_…) → upserts are idempotent and
// re-syncing a session never duplicates rows.
//
// When the referenced message row doesn't exist yet (sync race: the message
// POST may still be in flight), the message is created first via upsert so
// the FK always resolves — order-of-arrival independence.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureSession } from '../../ensure-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Hard server-side cap per attachment — matches the client's
/// MAX_DATAURL_LENGTH guard (1.6M base64 chars ≈ 1.2MB binary). Anything
/// larger is rejected rather than silently truncated.
const MAX_BASE64_LENGTH = 1_600_000;

function parseDataUrl(dataUrl: unknown): { mimeType: string; data: string; sizeBytes: number } | null {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) return null;
  const [, mimeType, data] = m;
  const compact = data.replace(/\s/g, '');
  if (!compact || compact.length > MAX_BASE64_LENGTH) return null;
  return { mimeType, data: compact, sizeBytes: Math.floor((compact.length * 3) / 4) };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const attachments = await db.sessionAttachment.findMany({
      where: { message: { sessionId: id } },
      orderBy: { createdAt: 'asc' },
    });
    return NextResponse.json({
      attachments: attachments.map((a) => ({
        id: a.id,
        messageId: a.messageId,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        dataUrl: `data:${a.mimeType};base64,${a.data}`,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to list attachments: ${message}` }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const messageId: string = body.messageId ?? '';
  const incoming: Array<{ id?: string; name?: string; dataUrl?: string }> = Array.isArray(body.attachments)
    ? body.attachments
    : [];

  if (!messageId) {
    return NextResponse.json({ error: 'messageId is required' }, { status: 400 });
  }

  try {
    // Auto-heal the session shell (same pattern as the messages route).
    const session = await db.session.findUnique({ where: { id } });
    if (!session) {
      const ensured = await ensureSession(id, body.documentId, body.title);
      if (!ensured) {
        return NextResponse.json({ error: 'Session not found' }, { status: 404 });
      }
    }

    // Ensure the message row exists (upsert — the message POST may still be
    // in flight; row content is filled/updated by that call afterwards).
    const existingMessage = await db.sessionMessage.findUnique({ where: { id: messageId } });
    if (!existingMessage) {
      await db.sessionMessage.create({
        data: {
          id: messageId,
          sessionId: id,
          role: 'user',
          content: body.content ?? '',
          status: 'complete',
        },
      });
    }

    let saved = 0;
    const skipped: string[] = [];
    for (const att of incoming) {
      if (typeof att.id !== 'string' || !att.id) {
        skipped.push('missing attachment id');
        continue;
      }
      const parsed = parseDataUrl(att.dataUrl);
      if (!parsed) {
        skipped.push(`${att.name ?? att.id}: not a valid (or size-capped) base64 image data URL`);
        continue;
      }
      // Idempotent upsert keyed by the client attachment id.
      await db.sessionAttachment.upsert({
        where: { id: att.id },
        update: {
          name: att.name ?? att.id,
          mimeType: parsed.mimeType,
          sizeBytes: parsed.sizeBytes,
          data: parsed.data,
        },
        create: {
          id: att.id,
          messageId,
          name: att.name ?? att.id,
          mimeType: parsed.mimeType,
          sizeBytes: parsed.sizeBytes,
          data: parsed.data,
        },
      });
      saved++;
    }

    return NextResponse.json({ saved, skipped });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to sync attachments: ${message}` }, { status: 500 });
  }
}
