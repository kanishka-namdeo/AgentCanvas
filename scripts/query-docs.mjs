import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
const adapter = new PrismaLibSql({ url: 'file:/home/z/my-project/db/custom.db' });
const p = new PrismaClient({ adapter });
const n = await p.document.count();
console.log('document count:', n);
const docs = await p.document.findMany({ orderBy: { updatedAt: 'desc' }, take: 5 });
for (const d of docs) {
  const shapeCount = d.shapes ? (Array.isArray(d.shapes) ? d.shapes.length : Object.keys(d.shapes).length) : 'null';
  console.log('DOC', d.id.slice(0,30), JSON.stringify(d.name), 'shapes:', shapeCount, 'upd:', d.updatedAt?.toISOString().slice(11,19));
}
await p.$disconnect();
