# AGENTS.md — `src/app/api/pen/`

## Purpose

`.pen` file conversion endpoints — bidirectional translation between the on-disk `.pen` JSON format (an interchange spec) and the in-memory `CanvasDocument` shape (with its `shapes` tree, tokens, and viewport). Used by the File menu's Import `.pen` and Export `.pen` actions.

## Ownership

- `import/route.ts` — POST: `.pen` → `CanvasDocument` + patches. Converts the `.pen` JSON to a `CanvasDocument`, resolves the `.pen` tree to populate `canvas.shapes`, extracts variables as tokens, and emits a patch sequence (`clear` + `bulk_add` + `tokens` + `set_theme_axis`) the canvas store applies atomically.
- `export/route.ts` — POST: `CanvasDocument` → `.pen` file download. Validates the document has a `shapes` array, converts it to a `PenDocument`, serializes it, and streams it as an attachment.

## Local Contracts

### `/api/pen/import` request body

```ts
{
  pen: PenDocument;           // the .pen file contents
  documentId?: string;        // optional, defaults to 'default'
  mode?: "replace" | "merge"; // optional, defaults to 'replace'
}
```

### `/api/pen/import` response

```ts
{
  document: CanvasDocument;   // the converted canvas document
  patches: CanvasPatch[];     // patches to apply (clear + bulk_add + tokens + set_theme_axis)
}
```

**Contract**:
- The route MUST validate the `.pen` document structure using `isPenDocument()`.
- The route MUST convert using `penToCanvas()`.
- The route MUST resolve the `.pen` tree using `resolvePenTree()`.
- The route MUST extract variables as tokens using `variablesToTokens()`.
- In `replace` mode, the route MUST emit a `clear` patch before the `bulk_add`.
- The route MUST emit a `bulk_add` patch with the converted children tree.
- The route MUST emit `tokens` and `set_theme_axis` patches if the `.pen` file contains variables/themes.
- The route MUST catch conversion errors and return a 500 with a structured error message.

### `/api/pen/export` request body

```ts
{
  document: CanvasDocument;  // the canvas document to export (must have a `shapes` array)
  filename?: string;         // optional, defaults to (document.name ?? 'canvas') + '.pen'
}
```

### `/api/pen/export` response

JSON file download with `Content-Disposition: attachment` header.

**Contract**:
- The route MUST validate that the request contains a valid `CanvasDocument` with a `shapes` array. Returns 400 if missing.
- The route MUST convert using `canvasToPen()`.
- The route MUST serialize using `serializePenDocument()`.
- The route MUST set `Content-Type: application/json; charset=utf-8` AND `Content-Disposition: attachment; filename="..."`.
- The route MUST catch conversion errors and return a 500 with a structured error message.

## Work Guidance

- When changing the `CanvasDocument` shape: update the export conversion (`canvasToPen`), the import conversion (`penToCanvas`), and the `.pen` spec together.
- When adding a new shape type: update BOTH the import (parser) and export (serializer) paths — an asymmetric update silently drops shapes on round-trip.
- When changing the token model: update `variablesToTokens` (import) and the token-extraction in the export path together.

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual round-trip: export a canvas to `.pen` via `curl -X POST http://127.0.0.1:3000/api/pen/export -H 'Content-Type: application/json' -d '{"document":{...}}' > out.pen`, then import it back via `curl -X POST http://127.0.0.1:3000/api/pen/import -H 'Content-Type: application/json' -d '{"pen": <out.pen>}'` — the resulting `CanvasDocument` should be structurally equivalent to the original (same shape tree, same tokens, same viewport).
- Manual: `curl -X POST http://127.0.0.1:3000/api/pen/import -H 'Content-Type: application/json' -d '{"pen": "not-an-object"}'` — should return 400 or 500 (depending on `isPenDocument`'s exact rejection), NOT crash the process.

## Mistakes & Lessons

### Failure Modes

- Check that `mode: "replace"` emits a `clear` patch BEFORE the `bulk_add` — without it, importing into a non-empty canvas produces a hybrid tree of old + new shapes.
- Check that `canvasToPen` handles every shape type the canvas supports — asymmetric import/export silently drops shapes on round-trip.
- Check that the export route sets BOTH `Content-Type` AND `Content-Disposition` — a missing `Content-Disposition` makes the browser render the JSON inline instead of downloading it.
- Check that `isPenDocument()` rejects malformed input before the parser runs — a non-object `pen` field used to crash the parser with an opaque stack trace.

### Lessons Learned

- Do a round-trip test (export → import → structural compare) whenever the `CanvasDocument` or `.pen` shape changes — without it, asymmetric updates silently corrupt user files on save → reload.
- Do NOT mix `clear` + `bulk_add` into a single patch — the canvas store applies patches atomically per-event, and a combined patch makes partial-failure recovery impossible.

## Child DOX Index

No child AGENTS.md files. Direct children are individual `route.ts` files under `import/` and `export/` — each is a single route handler with no subroutes, all documented in the Ownership section above.
