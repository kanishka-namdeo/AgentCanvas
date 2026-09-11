# Comprehensive Testing Strategy Design

**Date:** 2026-09-11  
**Status:** Draft  
**Owner:** Agent

## Overview

Ensure every interaction, function, feature, and flow in the app can be tested both programmatically (automated assertions) and visually (pixel-perfect UI verification).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Testing Pyramid                        │
├─────────────────────────────────────────────────────────┤
│  E2E Tests (Playwright)                                 │
│  - 15-20 critical user flows                            │
│  - Cross-browser (Chromium, Firefox, WebKit)            │
│  - Visual snapshots (pixelmatch)                        │
├─────────────────────────────────────────────────────────┤
│  Component Tests (Storybook)                            │
│  - 60+ component stories                                │
│  - Interaction tests (click, type, keyboard)            │
│  - Accessibility tests (axe-core)                       │
│  - Visual snapshots per state                           │
├─────────────────────────────────────────────────────────┤
│  Unit Tests (Vitest + jsdom) [EXISTING]                 │
│  - 2526+ tests, 80% coverage                            │
│  - Patch ops, tools, store, serialization               │
└─────────────────────────────────────────────────────────┘
```

## Key Decisions

1. **Storybook for component isolation** — test every component state independently
2. **Playwright for E2E** — test critical user flows in real browsers
3. **Self-hosted Storybook** — deploy static build to Vercel/GitHub Pages (free)
4. **Playwright visual snapshots** — built-in pixelmatch, no external service
5. **axe-core integration** — automated accessibility testing in Storybook
6. **100% free tools** — zero cost for all testing infrastructure

## Tools (All Free, Open Source)

- **Storybook** (MIT) — component isolation + interaction testing
- **Playwright** (MIT) — E2E testing + visual snapshots
- **axe-core** (MIT) — accessibility testing
- **Vitest** (MIT) — unit testing (existing)

## Component Testing with Storybook

### Setup

```bash
npx storybook@latest init
```

### Configuration

- Framework: Next.js (App Router)
- Addon-essentials (controls, actions, viewport, backgrounds)
- Addon-a11y (axe-core accessibility testing)
- Addon-interactions (interaction testing)
- Addon-coverage (test coverage reporting)

### Story Structure

```typescript
// src/components/canvas/Toolbar.stories.tsx
import { Toolbar } from './Toolbar';
import { useCanvasStore } from '@/lib/canvas/store';

export default {
  component: Toolbar,
  decorators: [
    (Story) => {
      useCanvasStore.setState({ /* initial state */ });
      return <Story />;
    }
  ],
};

export const Default = {};
export const EmptyCanvas = { args: { canvasEmpty: true } };
export const AgentBusy = { args: { agentBusy: true } };
export const WithSelection = { args: { selectedIds: ['shape-1', 'shape-2'] } };

export const ClickSelectTool: Story = {
  play: async ({ canvas, userEvent }) => {
    const selectButton = canvas.getByLabelText('Select tool');
    await userEvent.click(selectButton);
    expect(selectButton).toHaveAttribute('aria-pressed', 'true');
  }
};
```

### Component Prioritization (60+ stories)

**Tier 1 — Core UI (20 stories, Week 1):**
- Canvas (empty, with shapes, with selection, agent busy)
- Toolbar (default, empty canvas, agent busy, with selection)
- AgentPanel (empty state, streaming, tool calls, queue)
- SettingsDialog (each of 8 sections)
- CommandPalette (default, search results, custom prompt)
- SessionSidebar (empty, with sessions, active session)
- PropertiesPanel (empty, single selection, multi-selection)
- LayersPanel (empty, with shapes, expanded containers)

**Tier 2 — Secondary UI (20 stories, Week 2):**
- AppMenu (all sections)
- PenFileMenu (import/export states)
- KeyboardShortcutsDialog (default, filtered)
- RunHistoryPanel (empty, with runs)
- SessionHeader (default, busy)
- DesignSystemPicker (with packs, selected pack)
- VersionHistoryDialog (empty, with checkpoints)
- ModelSwitcher (default, dropdown open)

**Tier 3 — Remaining Components (20+ stories, Week 3):**
- All UI primitives (Button, Dialog, Dropdown, etc.)
- Plugin UI components (AskUserQuestionDialog, TodoOverlay, BackgroundTaskList)
- Canvas sub-components (DomNode, MeasureOverlay, Guides)
- Onboarding flows

### Interaction Testing

```typescript
export const SubmitPrompt: Story = {
  play: async ({ canvas, userEvent }) => {
    const input = canvas.getByPlaceholderText('Describe what to build...');
    await userEvent.type(input, 'Create a login form');
    await userEvent.click(canvas.getByRole('button', { name: 'Send' }));
    
    expect(input).toHaveValue('');
    expect(canvas.getByText('Create a login form')).toBeInTheDocument();
  }
};
```

### Accessibility Testing

```typescript
export const AccessibleDefault = {
  parameters: {
    a11y: {
      config: {
        rules: [
          { id: 'color-contrast', enabled: true },
          { id: 'button-name', enabled: true }
        ]
      }
    }
  }
};
```

### Self-Hosting

```bash
npm run build-storybook
vercel --prod  # or gh-pages -d storybook-static
```

## E2E Testing with Playwright

### Setup

```bash
npm init playwright@latest
```

### Configuration

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  snapshotSettings: {
    maxDiffPixelRatio: 0.01,
    maxDiffPixels: 100,
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
```

### E2E Test Flows (15-20 tests)

**Tier 1 — Critical Flows (tested in all browsers):**

1. **Agent Chat Flow**
   - Open app → type prompt → submit → streaming response → tool calls → canvas updates
   - Assert: message appears, tool cards render, shapes appear on canvas
   - Visual: snapshot of chat panel with streaming response

2. **Canvas Operations**
   - Draw rectangle → select → move → resize → group → delete
   - Assert: shapes render, selection handles appear, group created
   - Visual: snapshot after each operation

3. **Session Management**
   - Create session → switch sessions → fork session → restore snapshot
   - Assert: sessions persist, canvas shared, fork copies messages
   - Visual: snapshot of session sidebar with multiple sessions

4. **Settings Navigation**
   - Open settings → navigate all 8 sections → change LLM provider → save
   - Assert: each section renders, settings persist to localStorage
   - Visual: snapshot of each settings section

5. **.pen Import/Export**
   - Export canvas → import .pen file → verify shapes restored
   - Assert: file downloads, import succeeds, shapes match
   - Visual: snapshot before export and after import (should match)

**Tier 2 — Important Flows (tested in Chromium only):**

6. **Keyboard Shortcuts** — test 10 critical chords
7. **Command Palette** — search, select, execute
8. **Theme Switching** — light/dark/system
9. **Layers Panel Interactions** — expand/collapse, drag-to-reparent, search
10. **Properties Panel** — select shape, edit properties

**Tier 3 — Edge Cases (tested in Chromium only):**

11. **Empty Canvas State** — placeholder text, drop zone
12. **Agent Busy State** — disabled buttons, spinner
13. **Error Recovery** — error message, retry
14. **Offline Mode** — queue edits, sync on reconnect
15. **Multi-Tab Sync** — WebSocket sync across tabs

### Visual Snapshot Strategy

```typescript
test('canvas operations', async ({ page }) => {
  await page.goto('/');
  
  await expect(page.locator('[data-ac-world]')).toBeVisible();
  await expect(page).toHaveScreenshot('empty-canvas.png', {
    maxDiffPixelRatio: 0.01,
  });

  await page.click('[data-testid="toolbar-rectangle"]');
  await page.mouse.move(100, 100);
  await page.mouse.down();
  await page.mouse.move(300, 300);
  await page.mouse.up();
  
  await expect(page).toHaveScreenshot('after-draw-rectangle.png');
});
```

### Test Organization

```
e2e/
├── critical/
│   ├── agent-chat.spec.ts
│   ├── canvas-operations.spec.ts
│   ├── session-management.spec.ts
│   ├── settings.spec.ts
│   └── pen-import-export.spec.ts
├── important/
│   ├── keyboard-shortcuts.spec.ts
│   ├── command-palette.spec.ts
│   ├── theme-switching.spec.ts
│   ├── layers-panel.spec.ts
│   └── properties-panel.spec.ts
├── edge-cases/
│   ├── empty-canvas.spec.ts
│   ├── agent-busy.spec.ts
│   ├── error-recovery.spec.ts
│   ├── offline-mode.spec.ts
│   └── multi-tab-sync.spec.ts
├── fixtures/
│   ├── test-document.pen
│   └── mock-api-responses.ts
└── utils/
    ├── canvas-helpers.ts
    └── assertion-helpers.ts
```

## Visual Regression Strategy

### Snapshot Management

```
__snapshots__/
├── storybook/
│   ├── canvas/
│   │   ├── default-chromium.png
│   │   ├── default-firefox.png
│   │   ├── empty-canvas-chromium.png
│   │   └── agent-busy-chromium.png
│   └── toolbar/
│       ├── default-chromium.png
│       └── with-selection-chromium.png
└── e2e/
    ├── agent-chat/
    │   ├── empty-state-chromium.png
    │   └── streaming-response-chromium.png
    └── canvas-operations/
        ├── after-draw-rectangle-chromium.png
        └── after-select-chromium.png
```

### Snapshot Thresholds

```typescript
snapshotSettings: {
  maxDiffPixelRatio: 0.01,  // 1% tolerance
  maxDiffPixels: 100,
  threshold: 0.2,
}
```

### Handling Dynamic Content

```typescript
await expect(page).toHaveScreenshot('canvas.png', {
  mask: [
    page.locator('[data-testid="timestamp"]'),
    page.locator('[data-testid="viewer-count"]'),
  ],
});
```

### Theme-Aware Snapshots

```typescript
test('light mode', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('themePreference', 'light');
  });
  await page.reload();
  await expect(page).toHaveScreenshot('light-mode.png');
});
```

### Viewport Coverage

```typescript
test('mobile (375px)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/');
  await expect(page).toHaveScreenshot('mobile.png');
});
```

### Handling Brittle Snapshots

1. **Stable selectors:** Use `data-testid` instead of class names
2. **Scoped snapshots:** Snapshot specific components, not entire pages
3. **Animation pausing:** Disable animations for consistent snapshots
4. **Font loading:** Wait for fonts to load before snapshot

## CI Integration

### GitHub Actions Workflow

```yaml
# .github/workflows/test.yml
name: Test Suite

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run test
      - run: npm run test:coverage

  storybook:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build-storybook
      - run: npx playwright test --config=playwright.storybook.config.ts

  e2e:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        browser: [chromium, firefox, webkit]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx playwright install --with-deps ${{ matrix.browser }}
      - run: npx playwright test --project=${{ matrix.browser }}

  a11y:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build-storybook
      - run: npx axe-storybook --build-dir storybook-static
```

## Developer Workflow

### Test Scripts

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:report": "playwright show-report",
    "test:storybook": "test-storybook",
    "test:all": "npm run test && npm run test:storybook && npm run test:e2e",
    "storybook": "storybook dev -p 6006",
    "build-storybook": "storybook build"
  }
}
```

### Local Development

```bash
npm run test              # Unit tests
npm run storybook         # Start Storybook dev server
npm run test:e2e          # Run E2E tests locally
npm run test:e2e:ui       # Playwright UI mode (interactive debugging)
npm run test:all          # Run all tests
```

### Before Committing

```bash
npm run test:all          # Run all tests (unit + storybook + e2e)
```

### Update Snapshots

```bash
npm run test:e2e -- --update-snapshots
npm run test:storybook -- --update-snapshots
```

## Documentation

Create `docs/testing-guide.md` with:
- Overview of testing strategy
- How to run tests
- How to write tests (unit, component, E2E)
- Visual snapshot workflow
- CI pipeline explanation

## Implementation Timeline

| Week | Phase | Deliverables |
|------|-------|--------------|
| Week 1 | Storybook Setup | Install Storybook, write 20 core component stories, add interaction + a11y tests |
| Week 2 | Playwright E2E | Install Playwright, write 15-20 E2E tests for critical flows |
| Week 3 | Visual Regression | Configure visual snapshots, integrate into CI, write testing guide |
| Week 4 | Polish | Add remaining 40 component stories, edge case E2E tests, documentation |

## Success Criteria

- ✅ Every component has at least one story
- ✅ Every critical user flow has an E2E test
- ✅ Visual snapshots capture key states
- ✅ Accessibility tests pass (WCAG 2.1 AA)
- ✅ CI pipeline runs all tests on every PR
- ✅ Developer workflow documented
- ✅ Zero cost (all tools are free and open source)

## What Gets Tested

- **Programmatic testing**: assertions on behavior (clicks, state changes, API calls)
- **Visual testing**: pixel-perfect screenshots compared across runs
- **Accessibility testing**: automated a11y checks (WCAG compliance)
- **Cross-browser testing**: same tests run in Chromium, Firefox, WebKit

## Integration with Existing Tests

- Vitest unit tests remain unchanged (2526+ tests)
- Storybook stories complement unit tests by testing component rendering
- Playwright E2E tests complement both by testing full user flows
- All three layers run in CI

## Risks & Mitigations

**Risk:** Visual snapshots are brittle  
**Mitigation:** Use stable selectors, scope snapshots, disable animations, wait for fonts

**Risk:** E2E tests are slow  
**Mitigation:** Run critical flows in all browsers, important/edge cases in Chromium only

**Risk:** Storybook stories become outdated  
**Mitigation:** Treat stories as living documentation, update with component changes

**Risk:** CI pipeline takes too long  
**Mitigation:** Run jobs in parallel, cache dependencies, use matrix builds
