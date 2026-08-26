'use client';

// Design-System Picker Modal.
//
// Renders a shadcn Dialog containing:
//   - Left column: list of pack cards (palette, name, description, tags)
//   - Right column: live PackShowcase for the currently-selected pack
//
// Open state is controlled by parent (`open` + `onOpenChange`). The
// parent also receives the chosen pack name via `onPick`.
//
// When the user clicks "Use this pack":
//   1. `setActivePack(name)` persists to localStorage
//   2. `onPick?.(name)` fires
//   3. `onOpenChange(false)` closes the modal

import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useDesignSystems, usePackDetail, setActivePack } from '@/hooks/use-design-systems';
import { PackShowcase } from './PackShowcase';
import type { PackSummary } from '@/lib/design-systems/types';

interface DesignSystemPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the user picks a pack and clicks "Use this pack". */
  onPick?: (packName: string) => void;
}

export function DesignSystemPicker({ open, onOpenChange, onPick }: DesignSystemPickerProps) {
  const { packs, loading, error } = useDesignSystems();
  // The user's explicit choice. If null, we fall back to the registry's
  // default pack — derived below via `effectiveSelected`.
  const [userSelected, setUserSelected] = useState<string | null>(null);
  const defaultPack = packs.find((p) => p.isDefault) ?? packs[0];
  // Effective selection: user's pick, else the default pack (so the
  // preview pane is never empty when the picker first opens).
  const effectiveSelected = userSelected ?? defaultPack?.name ?? null;

  // Lazy-load the selected pack's full detail (tokens + samples).
  const { pack, loading: packLoading } = usePackDetail(effectiveSelected);

  const handlePick = () => {
    if (!effectiveSelected) return;
    setActivePack(effectiveSelected);
    onPick?.(effectiveSelected);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-5xl w-[min(96vw,1100px)] p-0 gap-0 overflow-hidden"
        showCloseButton
      >
        <DialogHeader className="px-6 pt-6 pb-4 border-b ac-border-subtle">
          <DialogTitle className="text-xl">Choose a design system</DialogTitle>
          <DialogDescription>
            The agent will use this pack's palette, fonts, spacing, and component imports for
            every UI it generates in this session. Switch packs any time — every component
            re-renders with the new tokens.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-[300px_1fr] min-h-[500px] max-h-[70vh]">
          {/* Left: pack list */}
          <aside className="border-r ac-border-subtle overflow-y-auto p-4 space-y-2">
            {loading && <PackSkeleton />}
            {error && (
              <div className="text-sm ac-text-danger p-3 ac-surface-2 rounded-md">
                Failed to load packs: {error}
              </div>
            )}
            {!loading && !error && packs.length === 0 && (
              <div className="text-sm ac-text-3 p-3">No packs registered.</div>
            )}
            {packs.map((p) => (
              <PackCard
                key={p.name}
                pack={p}
                active={effectiveSelected === p.name}
                onClick={() => setUserSelected(p.name)}
              />
            ))}
          </aside>

          {/* Right: live preview + actions */}
          <section className="overflow-y-auto p-4 flex flex-col">
            {effectiveSelected && pack ? (
              <>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-base font-semibold ac-text-1 flex items-center gap-2">
                      {humanifyName(pack.name)}
                      {pack.isDefault && (
                        <Badge variant="secondary" className="text-[10px]">default</Badge>
                      )}
                    </h3>
                    <p className="text-xs ac-text-3">{pack.description}</p>
                  </div>
                </div>

                {packLoading ? (
                  <div className="flex-1 ac-surface-1 rounded-md animate-pulse" />
                ) : (
                  <PackShowcase pack={pack} />
                )}

                {/* Dependencies */}
                <div className="mt-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wide ac-text-3 mb-2">
                    Dependencies
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {pack.dependencies.map((d) => (
                      <Badge key={d.package} variant="outline" className="font-mono text-[10px]">
                        {d.package}@≥{d.min}
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* Import map */}
                <div className="mt-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wide ac-text-3 mb-2">
                    Import map
                  </h4>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] font-mono ac-surface-1 rounded-md p-3">
                    {Object.entries(pack.importMap).map(([comp, path]) => (
                      <div key={comp} className="flex justify-between gap-2">
                        <span className="ac-text-2">{comp}</span>
                        <span className="ac-text-3 truncate">{path}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center ac-text-3 text-sm">
                Pick a pack on the left to see a live preview.
              </div>
            )}
          </section>
        </div>

        <DialogFooter className="px-6 py-4 border-t ac-border-subtle flex-row justify-between">
          <p className="text-[11px] ac-text-3">
            The chosen pack is persisted to <code className="font-mono">localStorage</code> —
            the agent will pick it up automatically on next UI generation.
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="default" disabled={!effectiveSelected} onClick={handlePick}>
              Use this pack
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Pack card (left column) ─────────────────────────────────────────

function PackCard({
  pack, active, onClick,
}: { pack: PackSummary; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left p-3 rounded-md border ac-transition cursor-pointer',
        active
          ? 'ac-surface-2 border-[var(--ac-accent)] shadow-[inset_2px_0_0_0_var(--ac-accent)]'
          : 'ac-surface-0 ac-border-subtle hover:ac-surface-1',
      )}
    >
      <div className="flex items-center gap-1 mb-2">
        {/* Palette swatches */}
        <div className="flex gap-0.5 rounded-[3px] overflow-hidden border ac-border-subtle">
          {(['primary', 'background', 'accent', 'text'] as const).map((k) => (
            <div
              key={k}
              className="w-4 h-4"
              style={{ background: pack.palette[k] }}
              title={`${k}: ${pack.palette[k]}`}
            />
          ))}
        </div>
        {pack.isDefault && (
          <Badge variant="secondary" className="text-[9px] py-0 px-1.5 h-4">default</Badge>
        )}
      </div>
      <div className="text-sm font-semibold ac-text-1 mb-1">{humanifyName(pack.name)}</div>
      <p className="text-[11px] ac-text-3 leading-snug line-clamp-2 mb-2">{pack.description}</p>
      <div className="flex flex-wrap gap-1">
        {pack.bestFor.slice(0, 3).map((tag) => (
          <span
            key={tag}
            className="text-[9px] uppercase tracking-wide ac-text-3 ac-surface-2 px-1.5 py-0.5 rounded"
          >
            {tag}
          </span>
        ))}
      </div>
    </button>
  );
}

function PackSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="p-3 ac-surface-1 rounded-md animate-pulse h-24" />
      ))}
    </div>
  );
}

function humanifyName(name: string): string {
  const known: Record<string, string> = {
    'shadcn-default': 'shadcn / ui',
    'vercel-geist': 'Vercel Geist',
    'mantine-default': 'Mantine',
  };
  return known[name] ?? name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
