'use client';

// OnboardingDialog — the first-time user onboarding flow.
//
// A 2-step modal dialog shown once per browser (when useOnboarding.hasCompleted
// is false). Step 1 is a welcome screen with the value prop + animated demo.
// Step 2 is a template picker with 6 curated starters. Selecting a template
// completes onboarding AND pre-fills the chat input with the template's prompt
// (the user just hits Enter to generate their first design).
//
// Design rationale (informed by v0/Bolt/Lovable/Canva onboarding patterns):
//   - SHORT (2 steps, not 5-7): the real "aha" is the first generation, so we
//     minimize friction to get there.
//   - TEMPLATE PICKER over empty input: Canva/Figma/v0 all show starters
//     because an empty input is the #1 activation blocker.
//   - SKIP always available: never force users through onboarding.
//   - ANIMATED DEMO in step 1: a looping CSS animation of a prompt → design
//     generation, so users SEE what AgentCanvas does before they try it.
//   - TIER BADGE on each template: sets expectations ("Fast" = ~5s, "Detailed"
//     = ~60s) — matches v0's "generation time" hint.

import { useState, type CSSProperties } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Sparkles, ArrowRight, SkipForward, Wand2, Layout, Layers,
  Smartphone, GitBranch, X,
} from 'lucide-react';
import {
  useOnboarding,
  ONBOARDING_TEMPLATES,
  type OnboardingTemplate,
} from '@/lib/onboarding/store';

interface OnboardingDialogProps {
  /// Called when the user picks a template (the prompt is pre-filled into
  /// the chat input by the parent — this component doesn't own the input).
  onSelectTemplate: (prompt: string) => void;
}

export function OnboardingDialog({ onSelectTemplate }: OnboardingDialogProps) {
  const hasCompleted = useOnboarding((s) => s.hasCompleted);
  const complete = useOnboarding((s) => s.complete);
  const skip = useOnboarding((s) => s.skip);
  const [step, setStep] = useState<'welcome' | 'templates'>('welcome');

  // Don't render if onboarding is already completed.
  if (hasCompleted) return null;

  const handleSelectTemplate = (template: OnboardingTemplate) => {
    complete(template.id);
    onSelectTemplate(template.prompt);
  };

  const handleStartDesigning = () => {
    // "Start designing" goes to the template picker.
    setStep('templates');
  };

  const handleSkip = () => {
    skip();
  };

  return (
    <Dialog open={true}>
      <DialogContent
        className="max-w-2xl p-0 overflow-hidden gap-0"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        {step === 'welcome' ? (
          <WelcomeStep
            onStart={handleStartDesigning}
            onSkip={handleSkip}
          />
        ) : (
          <TemplateStep
            onSelect={handleSelectTemplate}
            onSkip={handleSkip}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Step 1: Welcome ──────────────────────────────────────────────────────

function WelcomeStep({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  return (
    <div className="flex flex-col">
      {/* Animated demo header */}
      <div className="relative h-48 ac-surface-2 overflow-hidden border-b ac-border-subtle">
        <AnimatedDemo />
      </div>

      {/* Content */}
      <div className="p-6 space-y-4">
        <DialogHeader className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg ac-brand-gradient text-white">
              <Sparkles className="h-4 w-4" />
            </div>
            <DialogTitle className="text-lg font-semibold">
              Welcome to AgentCanvas
            </DialogTitle>
          </div>
          <DialogDescription className="text-sm ac-text-3">
            Describe a design in plain English. The AI agent builds it on a
            Figma-like canvas — ready to edit, export, or iterate.
          </DialogDescription>
        </DialogHeader>

        {/* Value-prop bullets */}
        <div className="grid grid-cols-3 gap-3 py-2">
          <ValueProp
            icon={Wand2}
            title="Prompt → Design"
            description="Type a prompt, get a polished UI in seconds"
          />
          <ValueProp
            icon={Layout}
            title="Full Canvas"
            description="Drag, resize, restyle — like Figma"
          />
          <ValueProp
            icon={Layers}
            title="Export Ready"
            description="SVG, PNG, JSON, or .pen file"
          />
        </div>

        {/* CTAs */}
        <div className="flex items-center justify-between pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onSkip}
            className="text-xs ac-text-4 hover:ac-text-2"
          >
            <SkipForward className="h-3.5 w-3.5 mr-1" />
            Skip tour
          </Button>
          <Button onClick={onStart} size="sm" className="gap-1.5">
            Pick a starter
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ValueProp({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center text-center gap-1.5 p-2 rounded-lg ac-surface-1 border ac-border-subtle">
      <Icon className="h-4 w-4 text-[var(--ac-accent)]" />
      <div className="text-[11px] font-medium ac-text-1">{title}</div>
      <div className="text-[10px] ac-text-4 leading-tight">{description}</div>
    </div>
  );
}

// ── Animated demo ──────────────────────────────────────────────────────────
//
// A looping CSS animation that shows: prompt typing → design appearing on
// canvas. No images — pure CSS shapes that morph. Communicates the value prop
// in 3 seconds without a video.

function AnimatedDemo() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex items-center gap-6">
        {/* Left: prompt typing */}
        <div className="flex flex-col gap-1.5 w-44">
          <div className="text-[10px] ac-text-4 font-mono">prompt</div>
          <div className="text-[11px] ac-text-2 font-mono bg-[var(--ac-surface-1)] rounded px-2 py-1.5 border ac-border-subtle">
            Design a login screen
            <span className="inline-block w-1.5 h-3 bg-[var(--ac-accent)] ml-0.5 animate-pulse" />
          </div>
        </div>

        {/* Arrow */}
        <div className="flex items-center">
          <div className="w-8 h-px bg-[var(--ac-accent)] opacity-50" />
          <div
            className="w-0 h-0 border-l-4 border-l-[var(--ac-accent)] border-y-2 border-y-transparent opacity-50"
            style={{ animation: 'onboarding-pulse 2s ease-in-out infinite' }}
          />
        </div>

        {/* Right: design appearing */}
        <div className="flex flex-col gap-1.5 w-44">
          <div className="text-[10px] ac-text-4 font-mono">canvas</div>
          <div
            className="relative h-28 rounded-lg border ac-border-subtle ac-surface-1 overflow-hidden"
            style={{ animation: 'onboarding-fade-in 2s ease-out 0.5s both' }}
          >
            {/* Mock login card */}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-2">
              <div className="w-8 h-8 rounded-full ac-brand-gradient" />
              <div className="w-20 h-2 rounded-full bg-[var(--ac-text-3)] opacity-30" />
              <div className="w-24 h-4 rounded ac-surface-2 border ac-border-subtle" />
              <div className="w-24 h-4 rounded ac-surface-2 border ac-border-subtle" />
              <div className="w-24 h-5 rounded ac-brand-gradient" />
            </div>
          </div>
        </div>
      </div>
      <style>{`
        @keyframes onboarding-pulse {
          0%, 100% { opacity: 0.3; transform: translateX(0); }
          50% { opacity: 1; transform: translateX(2px); }
        }
        @keyframes onboarding-fade-in {
          0% { opacity: 0; transform: scale(0.95); }
          100% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}

// ── Step 2: Template picker ─────────────────────────────────────────────────

function TemplateStep({
  onSelect,
  onSkip,
}: {
  onSelect: (template: OnboardingTemplate) => void;
  onSkip: () => void;
}) {
  return (
    <div className="flex flex-col max-h-[80vh]">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b ac-border-subtle">
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-base font-semibold flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[var(--ac-accent)]" />
            Pick your first design
          </DialogTitle>
          <DialogDescription className="text-xs ac-text-4">
            Choose a starter — the agent will build it on the canvas. You can
            edit, restyle, or start over anytime.
          </DialogDescription>
        </DialogHeader>
        <Button
          variant="ghost"
          size="sm"
          onClick={onSkip}
          className="text-xs ac-text-4 hover:ac-text-2 flex-shrink-0"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Template grid */}
      <div className="grid grid-cols-2 gap-3 p-4 overflow-y-auto">
        {ONBOARDING_TEMPLATES.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
            onSelect={() => onSelect(template)}
          />
        ))}
      </div>

      {/* Footer hint */}
      <div className="px-4 py-2 border-t ac-border-subtle text-[10px] ac-text-4 text-center">
        Tip: you can also press <kbd className="ac-kbd">⌘K</kbd> anytime to browse more prompts
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  onSelect,
}: {
  template: OnboardingTemplate;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="group relative flex flex-col text-left gap-2 p-3 rounded-xl border ac-border-subtle ac-surface-1 hover:ac-surface-2 hover:border-[var(--ac-accent)] transition-all duration-150 cursor-pointer overflow-hidden"
    >
      {/* Visual preview (gradient mock) */}
      <div
        className={`h-16 rounded-lg bg-gradient-to-br ${template.gradient} opacity-90 relative overflow-hidden`}
      >
        {/* Mock UI shapes inside the gradient preview */}
        <div className="absolute inset-0 p-2 flex flex-col gap-1">
          <div className="h-1.5 w-3/4 rounded-full bg-white/40" />
          <div className="flex-1 flex gap-1 mt-1">
            <div className="flex-1 rounded bg-white/20" />
            <div className="flex-1 rounded bg-white/30" />
            <div className="flex-1 rounded bg-white/20" />
          </div>
          <div className="h-2 w-1/2 rounded bg-white/50 mt-auto" />
        </div>
        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
          <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-white text-[10px] font-medium bg-black/40 backdrop-blur-sm px-2 py-1 rounded-full">
            <Wand2 className="h-3 w-3" />
            Generate
          </div>
        </div>
      </div>

      {/* Text content */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium ac-text-1 truncate">
              {template.label}
            </span>
            <TierBadge tier={template.tier} />
          </div>
          <div className="text-[10px] ac-text-4 leading-tight mt-0.5 line-clamp-2">
            {template.description}
          </div>
        </div>
      </div>
    </button>
  );
}

function TierBadge({ tier }: { tier: 'Fast' | 'Standard' | 'Detailed' }) {
  const variant =
    tier === 'Fast'
      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
      : tier === 'Standard'
        ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20'
        : 'bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/20';
  return (
    <span
      className={`inline-flex items-center px-1 py-0 rounded text-[9px] font-medium border ${variant} flex-shrink-0`}
    >
      {tier}
    </span>
  );
}
