// Onboarding store — tracks first-time user onboarding state.
//
// Persists to localStorage key `agentcanvas.onboarding.v1`. The onboarding
// flow is shown ONCE per browser (when `hasCompleted` is false). The user can
// skip it (marks `hasCompleted=true` + `skipped=true`) or complete it (marks
// `hasCompleted=true` + `completedAt=<timestamp>`). A "Replay onboarding"
// command in the command palette resets `hasCompleted` to false.
//
// Design rationale: the onboarding flow is deliberately SHORT (2 steps:
// welcome + template picker) because the real "aha" moment is the FIRST
// agent generation — we want to get the user to their first prompt as fast
// as possible. The template picker uses the EXISTING prompt catalog
// (PROMPT_GROUPS in CommandPalette.tsx) so onboarding and the ⌘K palette
// show the same starters.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface OnboardingState {
  /// Whether the user has seen the onboarding (completed OR skipped).
  /// When false, the WelcomeDialog shows on next page load.
  hasCompleted: boolean;
  /// Whether the user explicitly skipped (vs completed the flow).
  /// Used for analytics — skipped users may have a different activation path.
  skipped: boolean;
  /// Timestamp (ms) when onboarding was completed. Null when not yet completed.
  completedAt: number | null;
  /// The template the user picked (null if skipped or no pick).
  /// Used to pre-fill the chat input on first prompt.
  selectedTemplateId: string | null;
}

interface OnboardingStore extends OnboardingState {
  /// Mark onboarding as completed (user picked a template OR clicked "Start designing").
  complete: (templateId?: string | null) => void;
  /// Mark onboarding as skipped (user clicked "Skip").
  skip: () => void;
  /// Reset onboarding state so it shows again (for "Replay onboarding" command).
  reset: () => void;
}

const DEFAULT_STATE: OnboardingState = {
  hasCompleted: false,
  skipped: false,
  completedAt: null,
  selectedTemplateId: null,
};

/// Analytics stub — emits a structured console event when onboarding is
/// completed or skipped. Replace with a real analytics SDK call when one
/// is integrated. The event shape is stable so a future analytics adapter
/// can consume it without changing the store.
function emitAnalyticsEvent(event: {
  type: 'onboarding_completed' | 'onboarding_skipped' | 'onboarding_reset';
  templateId: string | null;
  timestamp: number;
}): void {
  if (typeof console !== 'undefined' && typeof console.info === 'function') {
    console.info('[onboarding-analytics]', event);
  }
}

export const useOnboarding = create<OnboardingStore>()(
  persist(
    (set) => ({
      ...DEFAULT_STATE,
      complete: (templateId = null) => {
        const timestamp = Date.now();
        set({
          hasCompleted: true,
          skipped: false,
          completedAt: timestamp,
          selectedTemplateId: templateId,
        });
        emitAnalyticsEvent({
          type: 'onboarding_completed',
          templateId,
          timestamp,
        });
      },
      skip: () => {
        const timestamp = Date.now();
        set({
          hasCompleted: true,
          skipped: true,
          completedAt: timestamp,
          selectedTemplateId: null,
        });
        emitAnalyticsEvent({
          type: 'onboarding_skipped',
          templateId: null,
          timestamp,
        });
      },
      reset: () => {
        set({ ...DEFAULT_STATE });
        emitAnalyticsEvent({
          type: 'onboarding_reset',
          templateId: null,
          timestamp: Date.now(),
        });
      },
    }),
    {
      name: 'agentcanvas.onboarding.v1',
      version: 1,
    },
  ),
);

/// Onboarding template catalog — the 6 curated starters shown in the
/// TemplatePicker. Each template has a stable id, label, description, the
/// full prompt text, an expected tier badge (Fast/Standard/Detailed), and a
/// CSS gradient for the card's visual preview.
export interface OnboardingTemplate {
  id: string;
  label: string;
  description: string;
  prompt: string;
  tier: 'Fast' | 'Standard' | 'Detailed';
  gradient: string;
}

export const ONBOARDING_TEMPLATES: OnboardingTemplate[] = [
  {
    id: 'login-screen',
    label: 'Login Screen',
    description: 'Mobile login with logo, email/password, and sign-in button',
    prompt:
      "Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.",
    tier: 'Fast',
    gradient: 'from-blue-500 to-indigo-600',
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    description: 'Analytics dashboard with KPI cards and a chart',
    prompt:
      'Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.',
    tier: 'Standard',
    gradient: 'from-violet-400 to-purple-500',
  },
  {
    id: 'pricing',
    label: 'Pricing Page',
    description: 'Three-tier pricing cards with the middle one highlighted',
    prompt:
      "Design a pricing section with 3 plan cards side by side: Starter at $9/mo, Pro at $29/mo highlighted as 'Most Popular', and Enterprise at $99/mo. Each card lists at least 3 features.",
    tier: 'Standard',
    gradient: 'from-emerald-500 to-teal-600',
  },
  {
    id: 'data-table',
    label: 'Data Table',
    description: 'Sortable table with headers, rows, and pagination',
    prompt:
      'Design a data table for a user management page: 5 columns (Name, Email, Role, Status, Last Active), 6 rows with realistic data, a header row with sort indicators, and a pagination footer showing 1-6 of 24.',
    tier: 'Standard',
    gradient: 'from-slate-500 to-gray-600',
  },
  {
    id: 'bar-chart',
    label: 'Bar Chart',
    description: 'Monthly revenue chart with 6 bars and value labels',
    prompt:
      "Create a card containing a bar chart titled 'Monthly Revenue' with six bars for Jan to Jun showing 12k, 18k, 15k, 24k, 29k and 33k, with value labels above each bar.",
    tier: 'Fast',
    gradient: 'from-amber-500 to-orange-600',
  },
  {
    id: 'landing',
    label: 'Landing Page',
    description: 'Full marketing page with hero, features, and footer',
    prompt:
      "Design a marketing landing page for an AI design tool called 'Prism': sticky nav with logo + 4 links + Sign Up CTA, a hero with headline + subhead + 2 CTAs + product mockup, a 3-feature grid, a testimonials carousel (2 cards visible), a pricing teaser (2 plans), and a footer with 4 link columns.",
    tier: 'Detailed',
    gradient: 'from-orange-500 to-pink-600',
  },
  {
    id: 'kanban',
    label: 'Kanban Board',
    description: 'Three columns with task cards and colored tags',
    prompt:
      'Create a kanban board with three columns — To Do, In Progress, Done — each column with a header and two task cards with realistic task titles.',
    tier: 'Standard',
    gradient: 'from-cyan-500 to-blue-600',
  },
  {
    id: 'mobile-profile',
    label: 'Mobile Profile',
    description: 'User profile card with avatar, stats, and action buttons',
    prompt:
      "Design a mobile user profile screen: a circular avatar at the top, the name 'Maya Chen', the job title 'Product Designer', a row of three stats (128 Followers, 342 Following, 56 Posts), and two buttons 'Edit Profile' and 'Share Profile'.",
    tier: 'Fast',
    gradient: 'from-pink-500 to-rose-600',
  },
  {
    id: 'design-system',
    label: 'Design System',
    description: 'Color palette + typography + button variants',
    prompt:
      'Design a design-system starter page: a color palette section with 6 swatches (primary, secondary, accent, success, warning, danger) each labeled with hex codes, a typography section showing 4 text styles (H1, H2, body, caption) with font sizes, and a button variants section showing primary, secondary, and ghost buttons.',
    tier: 'Detailed',
    gradient: 'from-indigo-500 to-blue-600',
  },
  {
    id: 'onboarding-flow',
    label: 'Onboarding Flow',
    description: '3-screen mobile onboarding with hero, features, and signup',
    prompt:
      'Design a 3-screen mobile onboarding flow side-by-side on the canvas: Screen 1 = hero image + headline + Skip; Screen 2 = icon + 3 bullet features + Next; Screen 3 = email/password form + Sign Up CTA + "Already have an account? Sign in".',
    tier: 'Detailed',
    gradient: 'from-rose-500 to-red-600',
  },
];
