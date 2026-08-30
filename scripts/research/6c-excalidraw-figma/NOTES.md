# Task 6-c — Excalidraw + Figma multiplayer research notes

Clone: /home/z/my-project/research-scan/excalidraw @ commit `e1bb9ff` (sparse: packages/excalidraw + excalidraw-app)
Fetched artifacts: figma-2019-jina.txt (full blog text via r.jina.ai), figma-2022-reliable.txt, figma-rust.txt, hn-figma-multiplayer-2019.json (HN 21378858), hn-2025-figma.json (HN 44922362)

## Key source files (excalidraw)
- packages/excalidraw/data/reconcile.ts — reconcileElements + shouldDiscardRemoteElement (Q2)
- excalidraw-app/collab/Collab.tsx — room init, remote handling, firebase save, idle/presence (Q1/Q3/Q4)
- excalidraw-app/collab/Portal.tsx — socket wire protocol, delta broadcast, broadcastedElementVersions (Q1)
- excalidraw-app/app_constants.ts — all timers (300ms local save, 20s full sync, 33ms cursor, 5s init timeout, 24h tombstone GC)
- excalidraw-app/data/firebase.ts — Firestore scenes/{roomId} {sceneVersion, ciphertext, iv}; runTransaction + reconcile on save
- excalidraw-app/data/LocalData.ts + localStorage.ts + tabSync.ts — 300ms debounced localStorage + IndexedDB files, pause during collab
- packages/excalidraw/data/restore.ts — bumpElementVersions (post-reconcile version bump)

## Constants (excalidraw-app/app_constants.ts)
SAVE_TO_LOCAL_STORAGE_TIMEOUT=300; INITIAL_SCENE_UPDATE_TIMEOUT=5000; FILE_UPLOAD_TIMEOUT=300;
LOAD_IMAGES_TIMEOUT=500; SYNC_FULL_SCENE_INTERVAL_MS=20000; SYNC_BROWSER_TABS_TIMEOUT=50;
CURSOR_SYNC_TIMEOUT=33 (~30fps); DELETED_ELEMENT_TIMEOUT=24h.

## Figma sources
- 2019: How Figma's multiplayer technology works (figma-2019-jina.txt)
- 2022: Making multiplayer more reliable — journal/WAL, seq numbers, checkpoints, DynamoDB lock (figma-2022-reliable.txt)
- 2018: Rust in production at Figma — one worker per doc, Rust child per doc (figma-rust.txt)
- "How Figma scaled multiplayer" URL → 404 (does not exist); used the above as follow-ups.
- Room-manager server (excalidraw/excalidraw-room-manager) source NOT fetchable (404 + GH API rate-limited) — server semantics inferred from client code (labeled unverified).
