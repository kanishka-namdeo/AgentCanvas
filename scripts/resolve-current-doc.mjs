// Resolve the CURRENT demo document and report all resolver warnings —
// verifies the new contrast_failure / hug_fill_conflict / fill_without_parent
// lints against the live post-run canvas.
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
const adapter = new PrismaLibSql({ url: 'file:/home/z/my-project/db/custom.db' });
const db = new PrismaClient({ adapter });

const snap = await db.documentSnapshot.findFirst({
  where: { documentId: 'demo', source: 'server' },
  orderBy: { createdAt: 'desc' },
});
if (!snap) {
  console.log('no checkpoint snapshot found');
  process.exit(0);
}
const doc = typeof snap.document === 'string' ? JSON.parse(snap.document) : snap.document;
console.log('doc loaded: children =', doc.children?.length, 'variables =', Object.keys(doc.variables ?? {}).length);

const { resolvePenTreeDetailed } = await import('../src/lib/pen/resolve.ts');
const { layers, warnings } = resolvePenTreeDetailed(doc);
console.log('layers =', layers.length);
const byKind = {};
for (const w of warnings) byKind[w.kind] = (byKind[w.kind] ?? 0) + 1;
console.log('warnings by kind:', JSON.stringify(byKind, null, 2));
for (const w of warnings.filter((x) => x.kind === 'contrast_failure').slice(0, 8)) {
  console.log(`- [${w.nodeId}] ${w.message.slice(0, 180)}`);
}
await db.$disconnect();
