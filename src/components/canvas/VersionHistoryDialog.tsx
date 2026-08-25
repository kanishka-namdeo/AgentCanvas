'use client';

// Version History dialog (spec Phase 7 group C — defect D14).
//
// Figma Make's recoverable-writes surface: a compact list of named
// checkpoints — auto-captured at each agent turn end, or saved manually with
// ⌘⌥S / the "Save checkpoint" button. Restoring is never destructive (the
// store captures a "Before restore" checkpoint + pushes an undo entry), so
// the Restore button is the only destructive-looking action here and it is
// disabled while the agent is mid-turn (restoring under a streaming agent
// would corrupt its working document — same guard as undo/redo).
//
// Opened from the TopMenuBar's File → "Version history…".

import { useCanvasStore } from '@/lib/canvas/store';
import { timeAgo } from '@/lib/canvas/version-history';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

interface VersionHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function VersionHistoryDialog({ open, onOpenChange }: VersionHistoryDialogProps) {
  const checkpoints = useCanvasStore((s) => s.checkpoints);
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const addCheckpoint = useCanvasStore((s) => s.addCheckpoint);
  const restoreCheckpoint = useCanvasStore((s) => s.restoreCheckpoint);
  const clearCheckpoints = useCanvasStore((s) => s.clearCheckpoints);

  const saveManual = () => {
    const name = window.prompt('Checkpoint name:', 'Manual save') ?? 'Manual save';
    const saved = addCheckpoint(name, false);
    if (saved) toast.success('Checkpoint saved', { description: name });
    else toast.message('No changes since the last checkpoint');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Every agent turn is checkpointed automatically. Restoring keeps the current state as a &ldquo;Before restore&rdquo; checkpoint and an undo step.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 overflow-y-auto -mx-1 px-1" data-testid="version-history-list">
          {checkpoints.length === 0 ? (
            <p className="py-8 text-center text-xs ac-text-4">No checkpoints yet — chat with the agent or press ⌘⌥S.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {checkpoints.map((cp) => (
                <li
                  key={cp.id}
                  className="flex items-center gap-2 rounded-sm border ac-border-subtle ac-surface-1 px-2 py-1.5 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium ac-text-1">{cp.label}</span>
                      {cp.auto && <Badge variant="secondary" className="h-4 px-1 text-[9px]">auto</Badge>}
                    </div>
                    <span className="ac-text-3">
                      {timeAgo(cp.createdAt)} · {cp.document.shapes?.length ?? 0} layers
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    disabled={agentBusy}
                    title={agentBusy ? 'Stop the agent before restoring' : 'Restore this checkpoint'}
                    onClick={() => {
                      const ok = restoreCheckpoint(cp.id);
                      if (ok) toast.success('Restored', { description: cp.label });
                    }}
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[11px] ac-text-danger"
            disabled={checkpoints.length === 0}
            onClick={() => clearCheckpoints()}
          >
            Clear
          </Button>
          <Button size="sm" className="h-7 text-[11px]" onClick={saveManual}>
            Save checkpoint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
