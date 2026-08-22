// ensure-session.ts — shared server-side helper for the /api/sessions* routes.
//
// Not a route file (Next.js only maps special filenames like route.ts);
// colocated here because it is server-only (imports Prisma).
//
// Purpose: auto-heal the parent `Session` row when a child write (run /
// message / snapshot) arrives for a session id the server doesn't know.
//
// Background: before client-supplied session ids were introduced, the client
// created sessions with local `sess_*` ids while the server generated its own
// cuid — every child write then failed with a ForeignKeyConstraintViolation.
// The client now sends its session id (+ documentId) on every sync call; this
// helper lets child routes transparently create the missing shell row so old
// localStorage sessions heal on their next activity instead of erroring.

import { db } from '@/lib/db';

export async function ensureSession(
  id: string,
  documentId?: string,
  title?: string,
): Promise<boolean> {
  const existing = await db.session.findUnique({ where: { id }, select: { id: true } });
  if (existing) return true;
  if (!documentId) return false; // cannot create a shell without a documentId
  await db.session.create({
    data: {
      id,
      documentId,
      title: title || 'Recovered chat',
      lastOpenedAt: new Date().toISOString(),
    },
  });
  return true;
}
