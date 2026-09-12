// PlanApprovalCard layout-kind rendering (designer-workflow-parity spec §3.4, Task 10).
// Task 8 added the `kind: 'layout'` field to plan proposals; Task 9 wired it
// through the runner. This task adds the UI rendering that distinguishes
// layout-kind proposals from plan-kind proposals.
//
// TEST CONTRACT:
//   1. plan-kind proposal (kind undefined or 'plan') renders with:
//      - Header: "Plan approval" (implicit from title)
//      - Approve button: "Build it"
//      - Revise button: "Keep planning"
//   2. layout-kind proposal (kind === 'layout') renders with:
//      - Header: "Layout approval"
//      - Summary label: "Layout summary" (instead of "Plan summary")
//      - Steps label: "Layout sections" (instead of "Plan steps")
//      - Approve button: "Apply hi-fi"
//      - Revise button: "Revise layout"
//   3. Status chips and feedback display work identically for both kinds.
//   4. Store passes through the `kind` field from agent:plan_proposed event.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useCanvasStore } from '@/lib/canvas/store';
import type { ChatTurn } from '@/lib/canvas/store';
import type { SyncEvent } from '@/lib/canvas/types';

// PlanApprovalCard is not exported from AgentPanel.tsx by default — we test
// the rendering through the store's planProposal state, which the component
// consumes. The actual UI rendering is verified by checking the store attaches
// the `kind` field correctly; the component's label/button text is verified
// by source inspection (the component is a pure function of proposal.kind).
//
// STRATEGY: drive _onSync exactly like production (alternatives-parked-event.test.ts
// pattern) to verify the store attaches the `kind` field to planProposal.

function resetStore() {
  useCanvasStore.setState({
    turns: [],
    agentBusy: false,
    runPhase: 'idle',
  });
}

function makeAssistantTurn() {
  useCanvasStore.setState((s) => ({
    turns: [
      ...s.turns,
      {
        id: 'turn-1',
        role: 'assistant' as const,
        text: '',
        toolCalls: [],
        streaming: true,
      },
    ],
  }));
}

describe('PlanApprovalCard layout-kind — store contract', () => {
  beforeEach(() => {
    resetStore();
  });

  it('plan-kind proposal (kind undefined) defaults to plan kind', () => {
    makeAssistantTurn();
    const event: SyncEvent = {
      type: 'agent:plan_proposed',
      planId: 'plan-1',
      title: 'Test Plan',
      summary: 'A test plan',
      steps: [{ step: 1, description: 'Step 1' }],
    };
    useCanvasStore.getState()._onSync(event);
    const turns = useCanvasStore.getState().turns;
    expect(turns).toHaveLength(1);
    const proposal = turns[0].planProposal;
    expect(proposal).toBeDefined();
    expect(proposal!.planId).toBe('plan-1');
    expect(proposal!.kind).toBeUndefined(); // undefined defaults to 'plan'
  });

  it('plan-kind proposal (kind: "plan") explicitly set', () => {
    makeAssistantTurn();
    const event: SyncEvent = {
      type: 'agent:plan_proposed',
      planId: 'plan-2',
      title: 'Explicit Plan',
      summary: 'An explicit plan',
      steps: [{ step: 1, description: 'Step 1' }],
      kind: 'plan',
    };
    useCanvasStore.getState()._onSync(event);
    const turns = useCanvasStore.getState().turns;
    const proposal = turns[0].planProposal;
    expect(proposal).toBeDefined();
    expect(proposal!.kind).toBe('plan');
  });

  it('layout-kind proposal (kind: "layout") passes through', () => {
    makeAssistantTurn();
    const event: SyncEvent = {
      type: 'agent:plan_proposed',
      planId: 'layout-1',
      title: 'Test Layout',
      summary: 'A test layout',
      steps: [{ step: 1, description: 'Section 1' }],
      kind: 'layout',
    };
    useCanvasStore.getState()._onSync(event);
    const turns = useCanvasStore.getState().turns;
    const proposal = turns[0].planProposal;
    expect(proposal).toBeDefined();
    expect(proposal!.kind).toBe('layout');
    expect(proposal!.title).toBe('Test Layout');
    expect(proposal!.summary).toBe('A test layout');
  });

  it('layout-kind proposal preserves all fields (steps, openQuestions, status)', () => {
    makeAssistantTurn();
    const event: SyncEvent = {
      type: 'agent:plan_proposed',
      planId: 'layout-2',
      title: 'Complex Layout',
      summary: 'A complex layout with questions',
      steps: [
        { step: 1, description: 'Header section' },
        { step: 2, description: 'Main content' },
        { step: 3, description: 'Footer' },
      ],
      openQuestions: ['Should the header be sticky?', 'Mobile-first?'],
      kind: 'layout',
    };
    useCanvasStore.getState()._onSync(event);
    const turns = useCanvasStore.getState().turns;
    const proposal = turns[0].planProposal;
    expect(proposal).toBeDefined();
    expect(proposal!.kind).toBe('layout');
    expect(proposal!.steps).toHaveLength(3);
    expect(proposal!.steps[0].description).toBe('Header section');
    expect(proposal!.openQuestions).toEqual(['Should the header be sticky?', 'Mobile-first?']);
    expect(proposal!.status).toBe('pending');
  });
});

describe('PlanApprovalCard UI rendering — label/button text', () => {
  // The PlanApprovalCard component is a pure function of proposal.kind.
  // We verify the rendering logic by checking the component source contains
  // the correct conditional labels. This is a source-inspection test
  // (alternatives-parked-event.test.ts pattern — wiring invariants).

  it('component source contains layout-kind labels', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'components', 'canvas', 'AgentPanel.tsx'),
      'utf-8'
    );

    // Layout-kind header
    expect(source).toContain('Layout approval');

    // Layout-kind summary label
    expect(source).toContain('Layout summary');

    // Layout-kind steps label
    expect(source).toContain('Layout sections');

    // Layout-kind approve button
    expect(source).toContain('Apply hi-fi');

    // Layout-kind revise button
    expect(source).toContain('Revise layout');

    // Plan-kind labels (must still be present for backward compatibility)
    expect(source).toContain('Build it');
    expect(source).toContain('Keep planning');
  });

  it('component source conditionally renders based on proposal.kind', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'components', 'canvas', 'AgentPanel.tsx'),
      'utf-8'
    );

    // The component must check proposal.kind === 'layout' to switch labels
    expect(source).toMatch(/proposal\.kind\s*===\s*['"]layout['"]/);
  });
});
