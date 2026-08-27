// Tests for version-history checkpoints (spec Phase 7 group C — defect D14).
//
// Covers the store slice semantics exactly as specified:
//   - addCheckpoint: captures a snapshot of the CURRENT document, newest
//     first, id/label/createdAt/auto recorded
//   - addCheckpoint: skips (returns false, no entry) when the document is
//     unchanged since the last checkpoint (signature match)
//   - checkpoints are capped at 50 (oldest dropped, index 0 = newest kept)
//   - restoreCheckpoint: unknown id → false, no state change
//   - restoreCheckpoint: adds a 'Before restore' checkpoint capturing the
//     current state, pushes the current document onto the undo stack,
//     clears redo, sets `document` to the checkpoint's stored document
//   - restore is recoverable: undo() walks back to the pre-restore document
//   - agent:turn_end integration: auto-checkpoint `Turn N` per turn, with
//     an incrementing turnCounter (via the store's _onSync handler)
//   - clearCheckpoints empties the list

import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import { checkpointSignature, timeAgo, MAX_CHECKPOINTS } from '@/lib/canvas/version-history';
import type { CanvasDocument, Shape } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';

// ---- Fixtures (mirror store.test.ts) ------------------------------------------

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'test-doc',
    name: 'Test',
    background: '#ffffff',
    version: '2.17',
    children: shapes as unknown as PenChild[],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

function makeShape(id: string): Shape {
  return {
    id,
    type: 'rectangle',
    name: id,
    x: 0, y: 0, width: 100, height: 100,
    rotation: 0, opacity: 1,
    fill: '#cccccc', stroke: '#000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000',
    parentId: null, zIndex: 0,
    locked: false, visible: true,
    autoLayout: null, tokenBinding: null, componentId: null,
    points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null,
    constraints: null,
  };
}

function resetStore(doc: CanvasDocument = makeDoc([])) {
  useCanvasStore.setState({
    document: doc,
    selectedIds: [],
    agentHighlightIds: [],
    socket: null,
    connected: false,
    viewerCount: 1,
    turns: [],
    agentBusy: false,
    documentId: 'test-doc',
    activeSessionId: null,
    undoStack: [],
    redoStack: [],
    checkpoints: [],
    lastCheckpointSignature: null,
    turnCounter: 0,
  });
  useSessionStore.setState({
    sessions: {},
    runs: {},
    messages: {},
    toolCalls: {},
    snapshots: {},
    activeSessionByDoc: {},
  });
}

// ---- Tests ---------------------------------------------------------------------

describe('version-history: addCheckpoint', () => {
  beforeEach(() => resetStore());

  it('captures the current document, newest first, with metadata', () => {
    const docA = makeDoc([makeShape('a')]);
    resetStore(docA);
    expect(useCanvasStore.getState().addCheckpoint('First', false)).toBe(true);
    const docB = makeDoc([makeShape('a'), makeShape('b')]);
    useCanvasStore.setState({ document: docB });
    expect(useCanvasStore.getState().addCheckpoint('Second', false)).toBe(true);

    const cps = useCanvasStore.getState().checkpoints;
    expect(cps).toHaveLength(2);
    expect(cps[0].label).toBe('Second'); // newest first
    expect(cps[0].document).toBe(docB);
    expect(cps[0].auto).toBe(false);
    expect(cps[1].label).toBe('First');
    expect(cps[1].document).toBe(docA);
    expect(typeof cps[0].id).toBe('string');
    expect(cps[0].id).not.toBe(cps[1].id);
    expect(cps[0].createdAt).toBeGreaterThan(0);
  });

  it('skips (returns false, no entry) when the document is unchanged', () => {
    const doc = makeDoc([makeShape('a')]);
    resetStore(doc);
    expect(useCanvasStore.getState().addCheckpoint('One', false)).toBe(true);
    // Same document → signature matches → no-op.
    expect(useCanvasStore.getState().addCheckpoint('Two', false)).toBe(false);
    expect(useCanvasStore.getState().checkpoints).toHaveLength(1);
    expect(useCanvasStore.getState().checkpoints[0].label).toBe('One');
    // Changing the document (a shape lands) invalidates the signature.
    useCanvasStore.setState({ document: makeDoc([makeShape('a'), makeShape('b')]) });
    expect(useCanvasStore.getState().addCheckpoint('Three', false)).toBe(true);
    expect(useCanvasStore.getState().checkpoints).toHaveLength(2);
  });

  it('caps at 50 checkpoints — drops oldest, keeps index 0 (newest)', () => {
    for (let i = 0; i < MAX_CHECKPOINTS + 5; i++) {
      useCanvasStore.setState({
        document: makeDoc(Array.from({ length: i + 1 }, (_, k) => makeShape(`s${i}-${k}`))),
      });
      useCanvasStore.getState().addCheckpoint(`cp${i}`, false);
    }
    const cps = useCanvasStore.getState().checkpoints;
    expect(cps).toHaveLength(MAX_CHECKPOINTS);
    expect(cps[0].label).toBe(`cp${MAX_CHECKPOINTS + 4}`); // newest kept at 0
    expect(cps[MAX_CHECKPOINTS - 1].label).toBe('cp5'); // cp0–cp4 (5 oldest) dropped
  });
});

describe('version-history: restoreCheckpoint', () => {
  beforeEach(() => resetStore());

  it('returns false for an unknown id and changes nothing', () => {
    const doc = makeDoc([makeShape('a')]);
    resetStore(doc);
    expect(useCanvasStore.getState().restoreCheckpoint('nope')).toBe(false);
    const s = useCanvasStore.getState();
    expect(s.document).toBe(doc);
    expect(s.checkpoints).toHaveLength(0);
    expect(s.undoStack).toHaveLength(0);
  });

  it('adds a Before-restore checkpoint, pushes undo, and sets the document', () => {
    const docA = makeDoc([makeShape('a')]);
    resetStore(docA);
    useCanvasStore.getState().addCheckpoint('Target', false);
    const targetId = useCanvasStore.getState().checkpoints[0].id;
    // Mutate past the checkpoint + seed a redo entry.
    const docB = makeDoc([makeShape('a'), makeShape('b'), makeShape('c')]);
    const redoEntry = makeDoc([makeShape('z')]);
    useCanvasStore.setState({ document: docB, redoStack: [redoEntry] });

    expect(useCanvasStore.getState().restoreCheckpoint(targetId)).toBe(true);

    const s = useCanvasStore.getState();
    expect(s.document).toBe(docA); // restored to the checkpoint's document
    expect(s.undoStack).toHaveLength(1);
    expect(s.undoStack[0]).toBe(docB); // pre-restore doc pushed for undo
    expect(s.redoStack).toHaveLength(0); // cleared like any mutation
    // A 'Before restore' checkpoint captured the CURRENT (pre-restore) state.
    expect(s.checkpoints[0].label).toBe('Before restore');
    expect(s.checkpoints[0].auto).toBe(false);
    expect(s.checkpoints[0].document).toBe(docB);
    expect(s.checkpoints[1].label).toBe('Target');
  });

  it('is recoverable — undo() walks back to the pre-restore document', () => {
    const docA = makeDoc([makeShape('a')]);
    resetStore(docA);
    useCanvasStore.getState().addCheckpoint('Target', false);
    const targetId = useCanvasStore.getState().checkpoints[0].id;
    const docB = makeDoc([makeShape('a'), makeShape('b')]);
    useCanvasStore.setState({ document: docB });

    useCanvasStore.getState().restoreCheckpoint(targetId);
    expect(useCanvasStore.getState().document).toBe(docA);

    useCanvasStore.getState().undo();
    const s = useCanvasStore.getState();
    expect(s.document).toBe(docB);
    expect(s.redoStack).toHaveLength(1);
    expect(s.redoStack[0]).toBe(docA);
  });
});

describe('version-history: agent:turn_end auto-checkpoint', () => {
  beforeEach(() => resetStore());

  it('creates an auto checkpoint `Turn N` per turn_end, with an incrementing counter', () => {
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });
    let s = useCanvasStore.getState();
    expect(s.checkpoints).toHaveLength(1);
    expect(s.checkpoints[0].label).toBe('Turn 1');
    expect(s.checkpoints[0].auto).toBe(true);
    expect(s.turnCounter).toBe(1);

    // The agent writes something during the next turn…
    useCanvasStore.setState({ document: makeDoc([makeShape('a')]) });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });
    s = useCanvasStore.getState();
    expect(s.checkpoints).toHaveLength(2);
    expect(s.checkpoints[0].label).toBe('Turn 2');
    expect(s.checkpoints[0].auto).toBe(true);
    expect(s.checkpoints[1].label).toBe('Turn 1');
    expect(s.turnCounter).toBe(2);
  });

  it('increments the counter but skips the checkpoint when the turn made no writes', () => {
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });
    // Second turn_end with an UNCHANGED document → signature matches → skip.
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });
    const s = useCanvasStore.getState();
    expect(s.turnCounter).toBe(2);
    expect(s.checkpoints).toHaveLength(1); // only Turn 1
    expect(s.checkpoints[0].label).toBe('Turn 1');
  });
});

describe('version-history: clearCheckpoints', () => {
  beforeEach(() => resetStore());

  it('empties the list and the signature cache', () => {
    useCanvasStore.setState({ document: makeDoc([makeShape('a')]) });
    useCanvasStore.getState().addCheckpoint('One', false);
    useCanvasStore.setState({ document: makeDoc([makeShape('a'), makeShape('b')]) });
    useCanvasStore.getState().addCheckpoint('Two', true);
    expect(useCanvasStore.getState().checkpoints).toHaveLength(2);

    useCanvasStore.getState().clearCheckpoints();

    const s = useCanvasStore.getState();
    expect(s.checkpoints).toHaveLength(0);
    expect(s.lastCheckpointSignature).toBeNull();
    // The same document now saves again (signature cache was cleared).
    expect(useCanvasStore.getState().addCheckpoint('Three', false)).toBe(true);
  });
});

describe('version-history: helpers', () => {
  it('checkpointSignature changes with children/shapes/variables', () => {
    const a = makeDoc([makeShape('a')]);
    const b = makeDoc([makeShape('a'), makeShape('b')]);
    expect(checkpointSignature(a)).not.toBe(checkpointSignature(b));
    const withVars = { ...makeDoc([]), variables: { accent: { type: 'color', value: '#ff0000' } } } as CanvasDocument;
    expect(checkpointSignature(makeDoc([]))).not.toBe(checkpointSignature(withVars));
    // Stable for the same document.
    expect(checkpointSignature(a)).toBe(checkpointSignature(makeDoc([makeShape('a')])));
  });

  it('timeAgo renders compact relative times', () => {
    const now = 1_000_000_000;
    expect(timeAgo(now, now)).toBe('just now');
    expect(timeAgo(now - 30_000, now)).toBe('30s ago');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});
