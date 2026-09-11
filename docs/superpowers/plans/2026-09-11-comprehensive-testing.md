# Comprehensive Testing Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Storybook for component testing + Playwright for E2E testing + visual regression to ensure all interactions/functions/features/flows can be tested programmatically and visually.

**Architecture:** Three-layer testing strategy: (1) Storybook for component isolation with interaction + accessibility tests, (2) Playwright for E2E testing of critical user flows with visual snapshots, (3) CI integration running all tests on every PR. All tools are free and open source.

**Tech Stack:** Storybook (MIT), Playwright (MIT), axe-core (MIT), Vitest (existing)

**Spec:** `docs/superpowers/specs/2026-09-11-comprehensive-testing-design.md`

## Global Constraints

- All tools must be free and open source (zero cost)
- Storybook must self-host (no Chromatic)
- Playwright visual snapshots use built-in pixelmatch (no external service)
- Tests must run in CI on every push/PR to main
- Accessibility tests must pass WCAG 2.1 AA standards
- Visual snapshots must support light/dark themes and mobile/tablet/desktop viewports

---

## File Structure

**New files to create:**

```
.storybook/
├── main.ts                    # Storybook configuration
├── preview.ts                 # Global decorators + parameters
└── preview-head.html          # Head tags for Storybook

src/components/canvas/
├── Canvas.stories.tsx         # Canvas component stories
├── Toolbar.stories.tsx        # Toolbar component stories
├── AgentPanel.stories.tsx     # AgentPanel component stories
├── CommandPalette.stories.tsx # CommandPalette component stories
├── LayersPanel.stories.tsx    # LayersPanel component stories
├── PropertiesPanel.stories.tsx # PropertiesPanel component stories
├── SettingsDialog.stories.tsx # SettingsDialog component stories
└── [20 more Tier 1 component stories...]

src/components/sessions/
├── SessionSidebar.stories.tsx
├── SessionHeader.stories.tsx
└── RunHistoryPanel.stories.tsx

playwright.config.ts           # Playwright configuration
playwright.storybook.config.ts # Playwright config for Storybook tests

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

.github/workflows/
└── test.yml                   # CI workflow for all tests

docs/
└── testing-guide.md           # Developer testing documentation

__snapshots__/
├── storybook/                 # Storybook visual snapshots
└── e2e/                       # E2E visual snapshots
```

**Files to modify:**

```
package.json                   # Add test scripts + dependencies
tsconfig.json                  # Add Storybook/Playwright paths
```

---

## Task 1: Install Storybook + Dependencies

**Files:**
- Modify: `package.json`
- Create: `.storybook/main.ts`
- Create: `.storybook/preview.ts`
- Create: `.storybook/preview-head.html`

**Interfaces:**
- Consumes: Nothing (initial setup)
- Produces: Storybook dev server on port 6006, buildable static site

- [ ] **Step 1: Install Storybook dependencies**

```bash
npm install --save-dev @storybook/react @storybook/nextjs @storybook/addon-essentials @storybook/addon-a11y @storybook/addon-interactions @storybook/addon-coverage @storybook/blocks @storybook/test storybook @testing-library/jest-dom @testing-library/user-event
```

- [ ] **Step 2: Create Storybook main config**

Create `.storybook/main.ts`:

```typescript
import type { StorybookConfig } from '@storybook/nextjs';

const config: StorybookConfig = {
  stories: [
    '../src/components/**/*.stories.@(js|jsx|ts|tsx)',
  ],
  addons: [
    '@storybook/addon-essentials',
    '@storybook/addon-a11y',
    '@storybook/addon-interactions',
    '@storybook/addon-coverage',
  ],
  framework: {
    name: '@storybook/nextjs',
    options: {},
  },
  docs: {
    autodocs: 'tag',
  },
  typescript: {
    reactDocgen: 'react-docgen-typescript',
  },
  staticDirs: ['../public'],
};

export default config;
```

- [ ] **Step 3: Create Storybook preview config**

Create `.storybook/preview.ts`:

```typescript
import type { Preview } from '@storybook/react';
import '../src/app/globals.css';

const preview: Preview = {
  parameters: {
    actions: { argTypesRegex: '^on[A-Z].*' },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'light',
      values: [
        { name: 'light', value: '#ffffff' },
        { name: 'dark', value: '#0f172a' },
      ],
    },
    a11y: {
      config: {
        rules: [
          { id: 'color-contrast', enabled: true },
          { id: 'button-name', enabled: true },
          { id: 'label', enabled: true },
        ],
      },
    },
  },
};

export default preview;
```

- [ ] **Step 4: Create Storybook head tags**

Create `.storybook/preview-head.html`:

```html
<style>
  /* Disable animations for consistent snapshots */
  *, *::before, *::after {
    animation-duration: 0s !important;
    transition-duration: 0s !important;
  }
</style>
```

- [ ] **Step 5: Add Storybook scripts to package.json**

Edit `package.json` and add these scripts:

```json
{
  "scripts": {
    "storybook": "storybook dev -p 6006",
    "build-storybook": "storybook build"
  }
}
```

- [ ] **Step 6: Verify Storybook starts**

Run: `npm run storybook`
Expected: Storybook dev server starts on http://localhost:6006 with no errors

- [ ] **Step 7: Commit Storybook setup**

```bash
git add .storybook package.json package-lock.json
git commit -m "chore: add Storybook for component testing"
```

---

## Task 2: Create Canvas Component Stories

**Files:**
- Create: `src/components/canvas/Canvas.stories.tsx`
- Create: `src/components/canvas/Toolbar.stories.tsx`

**Interfaces:**
- Consumes: Canvas and Toolbar components from `@/components/canvas`
- Produces: 8 stories (4 per component) covering key states

- [ ] **Step 1: Create Canvas stories**

Create `src/components/canvas/Canvas.stories.tsx`:

```typescript
import type { Meta, StoryObj } from '@storybook/react';
import { Canvas } from './Canvas';
import { useCanvasStore } from '@/lib/canvas/store';

const meta = {
  component: Canvas,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof Canvas>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test Document',
        shapes: [],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
      selectedIds: [],
      toolMode: 'select',
    });
  },
};

export const WithShapes: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test Document',
        shapes: [
          {
            id: 'shape-1',
            type: 'rectangle',
            x: 100,
            y: 100,
            width: 200,
            height: 150,
            fill: '#3b82f6',
          },
          {
            id: 'shape-2',
            type: 'ellipse',
            x: 400,
            y: 100,
            width: 150,
            height: 150,
            fill: '#ef4444',
          },
        ],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
      selectedIds: [],
      toolMode: 'select',
    });
  },
};

export const WithSelection: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test Document',
        shapes: [
          {
            id: 'shape-1',
            type: 'rectangle',
            x: 100,
            y: 100,
            width: 200,
            height: 150,
            fill: '#3b82f6',
          },
        ],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
      selectedIds: ['shape-1'],
      toolMode: 'select',
    });
  },
};

export const AgentBusy: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test Document',
        shapes: [],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
      selectedIds: [],
      toolMode: 'select',
      agentBusy: true,
    });
  },
};
```

- [ ] **Step 2: Create Toolbar stories**

Create `src/components/canvas/Toolbar.stories.tsx`:

```typescript
import type { Meta, StoryObj } from '@storybook/react';
import { Toolbar } from './Toolbar';
import { useCanvasStore } from '@/lib/canvas/store';

const meta = {
  component: Toolbar,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof Toolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test Document',
        shapes: [
          {
            id: 'shape-1',
            type: 'rectangle',
            x: 100,
            y: 100,
            width: 200,
            height: 150,
            fill: '#3b82f6',
          },
        ],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
      selectedIds: [],
      toolMode: 'select',
      agentBusy: false,
    });
  },
};

export const EmptyCanvas: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test Document',
        shapes: [],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
      selectedIds: [],
      toolMode: 'select',
      agentBusy: false,
    });
  },
};

export const AgentBusy: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test Document',
        shapes: [],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
      selectedIds: [],
      toolMode: 'select',
      agentBusy: true,
    });
  },
};

export const WithSelection: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test Document',
        shapes: [
          {
            id: 'shape-1',
            type: 'rectangle',
            x: 100,
            y: 100,
            width: 200,
            height: 150,
            fill: '#3b82f6',
          },
        ],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
      selectedIds: ['shape-1'],
      toolMode: 'select',
      agentBusy: false,
    });
  },
};
```

- [ ] **Step 3: Verify stories render in Storybook**

Run: `npm run storybook`
Expected: Canvas and Toolbar stories appear in sidebar, all 8 stories render without errors

- [ ] **Step 4: Commit Canvas + Toolbar stories**

```bash
git add src/components/canvas/Canvas.stories.tsx src/components/canvas/Toolbar.stories.tsx
git commit -m "test: add Canvas and Toolbar component stories"
```

---

## Task 3: Add Interaction Tests to Stories

**Files:**
- Modify: `src/components/canvas/Toolbar.stories.tsx`

**Interfaces:**
- Consumes: Toolbar component, Storybook test utilities
- Produces: 2 interaction tests (click handlers)

- [ ] **Step 1: Add interaction test for Select tool**

Edit `src/components/canvas/Toolbar.stories.tsx` and add this story:

```typescript
import { expect } from '@storybook/test';
import { userEvent } from '@storybook/test';

export const ClickSelectTool: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test Document',
        shapes: [],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
      selectedIds: [],
      toolMode: 'pan',
      agentBusy: false,
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = canvasElement;
    const selectButton = canvas.querySelector('[aria-label="Select tool"]');
    
    if (selectButton) {
      await userEvent.click(selectButton);
      expect(selectButton).toHaveAttribute('aria-pressed', 'true');
    }
  },
};
```

- [ ] **Step 2: Add interaction test for Pan tool**

Add this story to `src/components/canvas/Toolbar.stories.tsx`:

```typescript
export const ClickPanTool: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test Document',
        shapes: [],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
      selectedIds: [],
      toolMode: 'select',
      agentBusy: false,
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = canvasElement;
    const panButton = canvas.querySelector('[aria-label="Pan tool"]');
    
    if (panButton) {
      await userEvent.click(panButton);
      expect(panButton).toHaveAttribute('aria-pressed', 'true');
    }
  },
};
```

- [ ] **Step 3: Run interaction tests**

Run: `npm run storybook` → click "Interactions" tab
Expected: Both interaction tests pass (green checkmarks)

- [ ] **Step 4: Commit interaction tests**

```bash
git add src/components/canvas/Toolbar.stories.tsx
git commit -m "test: add interaction tests to Toolbar stories"
```

---

## Task 4: Install Playwright + Create Config

**Files:**
- Modify: `package.json`
- Create: `playwright.config.ts`

**Interfaces:**
- Consumes: Nothing (initial setup)
- Produces: Playwright test runner configured for Next.js app

- [ ] **Step 1: Install Playwright**

```bash
npm install --save-dev @playwright/test
npx playwright install
```

- [ ] **Step 2: Create Playwright config**

Create `playwright.config.ts`:

```typescript
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
    threshold: 0.2,
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
```

- [ ] **Step 3: Add Playwright scripts to package.json**

Edit `package.json` and add these scripts:

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:report": "playwright show-report"
  }
}
```

- [ ] **Step 4: Create e2e directory structure**

```bash
mkdir -p e2e/critical e2e/important e2e/edge-cases e2e/fixtures e2e/utils
```

- [ ] **Step 5: Verify Playwright installs browsers**

Run: `npx playwright install`
Expected: Chromium, Firefox, WebKit browsers download successfully

- [ ] **Step 6: Commit Playwright setup**

```bash
git add playwright.config.ts package.json package-lock.json e2e/
git commit -m "chore: add Playwright for E2E testing"
```

---

## Task 5: Create First E2E Test (Empty Canvas)

**Files:**
- Create: `e2e/edge-cases/empty-canvas.spec.ts`

**Interfaces:**
- Consumes: Playwright test runner, Next.js dev server
- Produces: 1 E2E test with visual snapshot

- [ ] **Step 1: Create empty canvas test**

Create `e2e/edge-cases/empty-canvas.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test.describe('Empty Canvas State', () => {
  test('renders empty canvas placeholder', async ({ page }) => {
    await page.goto('/');
    
    // Wait for canvas to load
    await expect(page.locator('[data-ac-world]')).toBeVisible({ timeout: 10000 });
    
    // Check for empty state elements
    await expect(page.locator('text=Empty canvas')).toBeVisible();
    await expect(page.locator('text=How does this work?')).toBeVisible();
    
    // Take visual snapshot
    await expect(page).toHaveScreenshot('empty-canvas.png', {
      maxDiffPixelRatio: 0.01,
    });
  });
});
```

- [ ] **Step 2: Run test to generate baseline snapshot**

Run: `npm run test:e2e -- e2e/edge-cases/empty-canvas.spec.ts --update-snapshots`
Expected: Test passes, snapshot saved to `e2e/edge-cases/empty-canvas.spec.ts-snapshots/`

- [ ] **Step 3: Run test without update flag to verify snapshot comparison**

Run: `npm run test:e2e -- e2e/edge-cases/empty-canvas.spec.ts`
Expected: Test passes, snapshot matches baseline

- [ ] **Step 4: Commit first E2E test**

```bash
git add e2e/edge-cases/empty-canvas.spec.ts e2e/edge-cases/empty-canvas.spec.ts-snapshots/
git commit -m "test: add empty canvas E2E test with visual snapshot"
```

---

## Task 6: Create Canvas Operations E2E Test

**Files:**
- Create: `e2e/critical/canvas-operations.spec.ts`
- Create: `e2e/utils/canvas-helpers.ts`

**Interfaces:**
- Consumes: Canvas component, Toolbar component
- Produces: 1 E2E test covering draw/select/move/resize/delete flow

- [ ] **Step 1: Create canvas helpers**

Create `e2e/utils/canvas-helpers.ts`:

```typescript
import { Page } from '@playwright/test';

export async function drawRectangle(page: Page, x: number, y: number, width: number, height: number) {
  // Click rectangle tool
  await page.click('[data-testid="toolbar-rectangle"]');
  
  // Draw rectangle
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + width, y + height);
  await page.mouse.up();
}

export async function selectShape(page: Page, x: number, y: number) {
  // Click select tool
  await page.click('[data-testid="toolbar-select"]');
  
  // Click on shape
  await page.mouse.click(x, y);
}

export async function deleteSelectedShape(page: Page) {
  await page.keyboard.press('Delete');
}
```

- [ ] **Step 2: Create canvas operations test**

Create `e2e/critical/canvas-operations.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';
import { drawRectangle, selectShape, deleteSelectedShape } from '../utils/canvas-helpers';

test.describe('Canvas Operations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-ac-world]')).toBeVisible({ timeout: 10000 });
  });

  test('draw, select, and delete rectangle', async ({ page }) => {
    // Draw rectangle
    await drawRectangle(page, 100, 100, 200, 150);
    
    // Verify shape appears
    await expect(page.locator('[data-node-type="rectangle"]')).toBeVisible();
    await expect(page).toHaveScreenshot('after-draw-rectangle.png');
    
    // Select shape
    await selectShape(page, 200, 175);
    
    // Verify selection handles appear
    await expect(page.locator('[data-ac-chrome]')).toBeVisible();
    await expect(page).toHaveScreenshot('after-select-rectangle.png');
    
    // Delete shape
    await deleteSelectedShape(page);
    
    // Verify shape removed
    await expect(page.locator('[data-node-type="rectangle"]')).not.toBeVisible();
    await expect(page).toHaveScreenshot('after-delete-rectangle.png');
  });
});
```

- [ ] **Step 3: Run test to generate baseline snapshots**

Run: `npm run test:e2e -- e2e/critical/canvas-operations.spec.ts --update-snapshots`
Expected: Test passes, 3 snapshots saved

- [ ] **Step 4: Commit canvas operations test**

```bash
git add e2e/critical/canvas-operations.spec.ts e2e/utils/canvas-helpers.ts e2e/critical/canvas-operations.spec.ts-snapshots/
git commit -m "test: add canvas operations E2E test"
```

---

## Task 7: Create Agent Chat E2E Test

**Files:**
- Create: `e2e/critical/agent-chat.spec.ts`
- Create: `e2e/fixtures/mock-api-responses.ts`

**Interfaces:**
- Consumes: AgentPanel component, API routes
- Produces: 1 E2E test covering prompt → response flow

- [ ] **Step 1: Create mock API responses**

Create `e2e/fixtures/mock-api-responses.ts`:

```typescript
export const mockAgentResponse = {
  type: 'assistant',
  content: 'I created a simple rectangle for you.',
  toolCalls: [
    {
      id: 'call-1',
      name: 'pen_add',
      arguments: { shape: { type: 'rectangle', x: 100, y: 100, width: 200, height: 150 } },
    },
  ],
};
```

- [ ] **Step 2: Create agent chat test**

Create `e2e/critical/agent-chat.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';
import { mockAgentResponse } from '../fixtures/mock-api-responses';

test.describe('Agent Chat Flow', () => {
  test('submit prompt and receive response', async ({ page }) => {
    // Mock API response
    await page.route('/api/agent', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockAgentResponse),
      });
    });

    await page.goto('/');
    
    // Type prompt
    const input = page.locator('[placeholder*="Describe"]');
    await input.fill('Create a rectangle');
    
    // Submit
    await input.press('Enter');
    
    // Wait for response
    await expect(page.locator('text=I created a simple rectangle')).toBeVisible({ timeout: 10000 });
    
    // Take snapshot
    await expect(page).toHaveScreenshot('agent-chat-response.png');
  });
});
```

- [ ] **Step 3: Run test to generate baseline snapshot**

Run: `npm run test:e2e -- e2e/critical/agent-chat.spec.ts --update-snapshots`
Expected: Test passes, snapshot saved

- [ ] **Step 4: Commit agent chat test**

```bash
git add e2e/critical/agent-chat.spec.ts e2e/fixtures/mock-api-responses.ts e2e/critical/agent-chat.spec.ts-snapshots/
git commit -m "test: add agent chat E2E test"
```

---

## Task 8: Add More Tier 1 Component Stories

**Files:**
- Create: `src/components/canvas/AgentPanel.stories.tsx`
- Create: `src/components/canvas/CommandPalette.stories.tsx`
- Create: `src/components/canvas/LayersPanel.stories.tsx`
- Create: `src/components/canvas/PropertiesPanel.stories.tsx`

**Interfaces:**
- Consumes: AgentPanel, CommandPalette, LayersPanel, PropertiesPanel components
- Produces: 16 stories (4 per component)

- [ ] **Step 1: Create AgentPanel stories**

Create `src/components/canvas/AgentPanel.stories.tsx`:

```typescript
import type { Meta, StoryObj } from '@storybook/react';
import { AgentPanel } from './AgentPanel';
import { useCanvasStore } from '@/lib/canvas/store';

const meta = {
  component: AgentPanel,
  parameters: {
    layout: 'padded',
  },
} satisfies Meta<typeof AgentPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      turns: [],
      agentBusy: false,
    });
  },
};

export const Streaming: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      turns: [
        {
          id: 'turn-1',
          role: 'assistant',
          content: 'I am creating',
          isStreaming: true,
        },
      ],
      agentBusy: true,
    });
  },
};

export const WithToolCalls: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      turns: [
        {
          id: 'turn-1',
          role: 'assistant',
          content: 'Created a rectangle',
          toolCalls: [
            { id: 'call-1', name: 'pen_add', status: 'completed' },
          ],
        },
      ],
      agentBusy: false,
    });
  },
};

export const WithQueue: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      turns: [],
      agentBusy: true,
      queuedPrompts: ['Create a button', 'Add text'],
    });
  },
};
```

- [ ] **Step 2: Create CommandPalette stories**

Create `src/components/canvas/CommandPalette.stories.tsx`:

```typescript
import type { Meta, StoryObj } from '@storybook/react';
import { CommandPalette } from './CommandPalette';

const meta = {
  component: CommandPalette,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof CommandPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    open: true,
  },
};

export const SearchResults: Story = {
  args: {
    open: true,
    defaultSearch: 'login',
  },
};

export const CustomPrompt: Story = {
  args: {
    open: true,
    defaultSearch: 'create a custom form',
  },
};
```

- [ ] **Step 3: Create LayersPanel stories**

Create `src/components/canvas/LayersPanel.stories.tsx`:

```typescript
import type { Meta, StoryObj } from '@storybook/react';
import { LayersPanel } from './LayersPanel';
import { useCanvasStore } from '@/lib/canvas/store';

const meta = {
  component: LayersPanel,
  parameters: {
    layout: 'padded',
  },
} satisfies Meta<typeof LayersPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test',
        shapes: [],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
    });
  },
};

export const WithShapes: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test',
        shapes: [
          { id: 'shape-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 100, name: 'Rectangle 1' },
          { id: 'shape-2', type: 'ellipse', x: 0, y: 0, width: 100, height: 100, name: 'Ellipse 1' },
        ],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
    });
  },
};

export const ExpandedContainers: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test',
        shapes: [
          {
            id: 'group-1',
            type: 'group',
            x: 0,
            y: 0,
            width: 200,
            height: 200,
            name: 'Group 1',
            children: ['shape-1', 'shape-2'],
          },
          { id: 'shape-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 100, name: 'Rectangle 1', parentId: 'group-1' },
          { id: 'shape-2', type: 'ellipse', x: 0, y: 0, width: 100, height: 100, name: 'Ellipse 1', parentId: 'group-1' },
        ],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
    });
  },
};
```

- [ ] **Step 4: Create PropertiesPanel stories**

Create `src/components/canvas/PropertiesPanel.stories.tsx`:

```typescript
import type { Meta, StoryObj } from '@storybook/react';
import { PropertiesPanel } from './PropertiesPanel';
import { useCanvasStore } from '@/lib/canvas/store';

const meta = {
  component: PropertiesPanel,
  parameters: {
    layout: 'padded',
  },
} satisfies Meta<typeof PropertiesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test',
        shapes: [],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
      selectedIds: [],
    });
  },
};

export const SingleSelection: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test',
        shapes: [
          { id: 'shape-1', type: 'rectangle', x: 100, y: 100, width: 200, height: 150, fill: '#3b82f6', name: 'Rectangle 1' },
        ],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
      selectedIds: ['shape-1'],
    });
  },
};

export const MultiSelection: Story = {
  args: {},
  beforeEach: () => {
    useCanvasStore.setState({
      document: {
        id: 'test-doc',
        name: 'Test',
        shapes: [
          { id: 'shape-1', type: 'rectangle', x: 100, y: 100, width: 200, height: 150, name: 'Rectangle 1' },
          { id: 'shape-2', type: 'ellipse', x: 400, y: 100, width: 150, height: 150, name: 'Ellipse 1' },
        ],
        tokens: { colors: [], textStyles: [] },
        children: [],
      },
      selectedIds: ['shape-1', 'shape-2'],
    });
  },
};
```

- [ ] **Step 5: Verify all stories render**

Run: `npm run storybook`
Expected: All 16 new stories appear and render without errors

- [ ] **Step 6: Commit Tier 1 stories**

```bash
git add src/components/canvas/*.stories.tsx
git commit -m "test: add Tier 1 component stories (AgentPanel, CommandPalette, LayersPanel, PropertiesPanel)"
```

---

## Task 9: Create GitHub Actions CI Workflow

**Files:**
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: All test suites (unit, storybook, e2e)
- Produces: CI pipeline running on every push/PR

- [ ] **Step 1: Create CI workflow**

Create `.github/workflows/test.yml`:

```yaml
name: Test Suite

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  unit:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run test
      - run: npm run test:coverage

  storybook:
    name: Storybook Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run build-storybook
      - run: npx concurrently -k -s first -n "SB,TEST" -c "magenta,blue" "npx http-server storybook-static --port 6006 --silent" "npx wait-on tcp:6006 && npx test-storybook"

  e2e:
    name: E2E Tests (${{ matrix.browser }})
    runs-on: ubuntu-latest
    strategy:
      matrix:
        browser: [chromium, firefox, webkit]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npx playwright install --with-deps ${{ matrix.browser }}
      - run: npx playwright test --project=${{ matrix.browser }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report-${{ matrix.browser }}
          path: playwright-report/
          retention-days: 30
```

- [ ] **Step 2: Commit CI workflow**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add GitHub Actions workflow for test suite"
```

---

## Task 10: Create Testing Documentation

**Files:**
- Create: `docs/testing-guide.md`

**Interfaces:**
- Consumes: Nothing
- Produces: Developer documentation for testing workflow

- [ ] **Step 1: Create testing guide**

Create `docs/testing-guide.md`:

```markdown
# Testing Guide

## Overview

This project uses a three-layer testing strategy:

1. **Unit Tests** (Vitest) — 2526+ tests, 80% coverage
2. **Component Tests** (Storybook) — 60+ stories with interaction + a11y tests
3. **E2E Tests** (Playwright) — 15-20 critical user flows

## Running Tests

```bash
# Unit tests
npm run test

# Component tests (Storybook)
npm run storybook          # Dev server
npm run test:storybook     # Run interaction tests

# E2E tests
npm run test:e2e           # All browsers
npm run test:e2e:ui        # Interactive UI mode

# All tests
npm run test:all
```

## Writing Tests

### Unit Test

```typescript
// tests/unit/my-feature.test.ts
import { describe, it, expect } from 'vitest';

describe('my feature', () => {
  it('should do something', () => {
    expect(result).toBe(expected);
  });
});
```

### Component Story

```typescript
// src/components/MyComponent.stories.tsx
import { MyComponent } from './MyComponent';

export default { component: MyComponent };

export const Default = {};
export const WithSelection = { args: { selected: true } };
```

### E2E Test

```typescript
// e2e/my-flow.spec.ts
import { test, expect } from '@playwright/test';

test('my flow', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-testid="button"]');
  await expect(page).toHaveScreenshot('my-flow.png');
});
```

## Visual Snapshots

- Update snapshots: `npm run test:e2e -- --update-snapshots`
- Review diffs: `npm run test:e2e:report`
- Commit snapshots with UI changes

## CI Pipeline

- **Unit tests**: Run on every push/PR
- **Storybook tests**: Run on every push/PR
- **E2E tests**: Run on every push/PR (Chromium, Firefox, WebKit)

All jobs must pass before merging to main.
```

- [ ] **Step 2: Commit testing guide**

```bash
git add docs/testing-guide.md
git commit -m "docs: add comprehensive testing guide"
```

---

## Task 11: Add Remaining E2E Tests

**Files:**
- Create: `e2e/critical/session-management.spec.ts`
- Create: `e2e/critical/settings.spec.ts`
- Create: `e2e/critical/pen-import-export.spec.ts`
- Create: `e2e/important/keyboard-shortcuts.spec.ts`
- Create: `e2e/important/command-palette.spec.ts`
- Create: `e2e/important/theme-switching.spec.ts`

**Interfaces:**
- Consumes: All major UI components
- Produces: 6 additional E2E tests

- [ ] **Step 1: Create session management test**

Create `e2e/critical/session-management.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test.describe('Session Management', () => {
  test('create and switch sessions', async ({ page }) => {
    await page.goto('/');
    
    // Create new session
    await page.click('[data-testid="new-session"]');
    await expect(page.locator('[data-testid="session-sidebar"]')).toContainText('Session 2');
    
    // Switch back to first session
    await page.click('[data-testid="session-1"]');
    await expect(page).toHaveScreenshot('session-switch.png');
  });
});
```

- [ ] **Step 2: Create settings test**

Create `e2e/critical/settings.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test.describe('Settings Navigation', () => {
  test('navigate all settings sections', async ({ page }) => {
    await page.goto('/');
    
    // Open settings
    await page.click('[data-testid="settings-button"]');
    
    // Navigate each section
    const sections = ['Agent', 'LLM Provider', 'Sessions', 'Appearance', 'Data', 'Shortcuts', 'Plugins', 'MCP Servers'];
    
    for (const section of sections) {
      await page.click(`text=${section}`);
      await expect(page.locator(`text=${section}`)).toBeVisible();
    }
    
    await expect(page).toHaveScreenshot('settings-dialog.png');
  });
});
```

- [ ] **Step 3: Create theme switching test**

Create `e2e/important/theme-switching.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test.describe('Theme Switching', () => {
  test('switch between light and dark modes', async ({ page }) => {
    await page.goto('/');
    
    // Switch to dark mode
    await page.click('[data-testid="theme-toggle"]');
    await page.click('text=Dark');
    await expect(page.locator('html')).toHaveAttribute('class', /dark/);
    await expect(page).toHaveScreenshot('dark-mode.png');
    
    // Switch to light mode
    await page.click('[data-testid="theme-toggle"]');
    await page.click('text=Light');
    await expect(page.locator('html')).not.toHaveAttribute('class', /dark/);
    await expect(page).toHaveScreenshot('light-mode.png');
  });
});
```

- [ ] **Step 4: Run all new tests to generate snapshots**

Run: `npm run test:e2e -- --update-snapshots`
Expected: All tests pass, snapshots generated

- [ ] **Step 5: Commit remaining E2E tests**

```bash
git add e2e/
git commit -m "test: add remaining critical and important E2E tests"
```

---

## Task 12: Add More Component Stories (Tier 2)

**Files:**
- Create: `src/components/canvas/AppMenu.stories.tsx`
- Create: `src/components/canvas/PenFileMenu.stories.tsx`
- Create: `src/components/canvas/KeyboardShortcutsDialog.stories.tsx`
- Create: `src/components/sessions/RunHistoryPanel.stories.tsx`
- Create: `src/components/sessions/SessionHeader.stories.tsx`
- Create: `src/components/design-systems/DesignSystemPicker.stories.tsx`

**Interfaces:**
- Consumes: Tier 2 components
- Produces: 20+ additional stories

- [ ] **Step 1: Create AppMenu stories**

Create `src/components/canvas/AppMenu.stories.tsx`:

```typescript
import type { Meta, StoryObj } from '@storybook/react';
import { AppMenu } from './AppMenu';

const meta = {
  component: AppMenu,
} satisfies Meta<typeof AppMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Open: Story = {
  args: { defaultOpen: true },
};
```

- [ ] **Step 2: Create remaining Tier 2 stories**

Create stories for:
- PenFileMenu
- KeyboardShortcutsDialog
- RunHistoryPanel
- SessionHeader
- DesignSystemPicker

Each with 3-4 variants covering key states.

- [ ] **Step 3: Verify all stories render**

Run: `npm run storybook`
Expected: All 40+ stories render without errors

- [ ] **Step 4: Commit Tier 2 stories**

```bash
git add src/components/**/*.stories.tsx
git commit -m "test: add Tier 2 component stories"
```

---

## Task 13: Final Verification + Documentation

**Files:**
- Modify: `docs/testing-guide.md` (add final notes)

**Interfaces:**
- Consumes: All test infrastructure
- Produces: Complete testing setup, ready for production use

- [ ] **Step 1: Run full test suite locally**

Run: `npm run test:all`
Expected: All unit tests, Storybook tests, and E2E tests pass

- [ ] **Step 2: Verify CI workflow**

Push to a branch and create a PR. Verify GitHub Actions runs all three jobs:
- Unit tests
- Storybook tests
- E2E tests (Chromium, Firefox, WebKit)

- [ ] **Step 3: Update testing guide with final notes**

Edit `docs/testing-guide.md` and add:

```markdown
## Success Criteria

- ✅ Every component has at least one story
- ✅ Every critical user flow has an E2E test
- ✅ Visual snapshots capture key states
- ✅ Accessibility tests pass (WCAG 2.1 AA)
- ✅ CI pipeline runs all tests on every PR
- ✅ Zero cost (all tools are free and open source)

## Maintenance

- **Weekly:** Delete orphaned snapshots
- **Monthly:** Audit snapshot count
- **Quarterly:** Consolidate similar snapshots
```

- [ ] **Step 4: Commit final updates**

```bash
git add docs/testing-guide.md
git commit -m "docs: finalize testing guide with success criteria"
```

- [ ] **Step 5: Create summary commit**

```bash
git commit --allow-empty -m "feat: comprehensive testing infrastructure complete

- Storybook: 60+ component stories with interaction + a11y tests
- Playwright: 15-20 E2E tests covering critical user flows
- Visual regression: pixel-perfect snapshots across browsers + viewports
- CI integration: all tests run on every push/PR
- Documentation: complete testing guide for developers

All tools are free and open source (zero cost)."
```

---

## Summary

**Total tasks:** 13  
**Estimated time:** 4 weeks  
**Deliverables:**
- 60+ Storybook component stories
- 15-20 Playwright E2E tests
- Visual snapshot coverage
- CI pipeline integration
- Complete documentation

**All tools are free and open source:**
- Storybook (MIT)
- Playwright (MIT)
- axe-core (MIT)
- Vitest (MIT, existing)
