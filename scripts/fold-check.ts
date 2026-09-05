// Direct test of journal-fold hydration for doc 'demo' —
// determines whether the fold reconstructs shapes from patch events.
import { hydrateDocumentFromJournal } from '../src/lib/canvas/journal-fold';

async function main() {
  const docId = process.argv[2] ?? 'demo';
  const h = await hydrateDocumentFromJournal(docId);
  const doc = h.document as any;
  console.log('foldedThroughSeq:', h.foldedThroughSeq);
  console.log('tombstones:', h.tombstones?.size);
  console.log('docName:', doc?.name);
  console.log('shapes:', doc?.shapes?.length);
  console.log('shapeNames:', (doc?.shapes ?? []).slice(0, 10).map((s: any) => s.name || s.type));
  console.log('tokens:', doc?.tokens ? Object.keys(doc.tokens).length : 0);
  console.log('keys:', doc ? Object.keys(doc) : 'none');
}
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
