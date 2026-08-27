"use client"

import * as React from "react"
import { GripVerticalIcon } from "lucide-react"
import {
  Group as ResizableGroup,
  Panel as ResizablePanelPrimitive,
  Separator as ResizableSeparatorPrimitive,
  type GroupProps,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels"

import { cn } from "@/lib/utils"

/**
 * ResizablePanelGroup — thin wrapper around react-resizable-panels v4's `Group`.
 *
 * v4 API notes:
 * - `direction="horizontal"` became `orientation="horizontal"`.
 * - `autoSaveId` is gone; persistence is now handled by `useDefaultLayout`
 *   at the call site. We expose `defaultLayout` + `onLayoutChanged` passthrough.
 * - The wrapper keeps the same public name so existing call sites in `page.tsx`
 *   only need to swap the v3-specific props.
 */
function ResizablePanelGroup({
  className,
  ...props
}: GroupProps) {
  return (
    <ResizableGroup
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full data-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({
  ...props
}: PanelProps) {
  return <ResizablePanelPrimitive data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizableSeparatorPrimitive
      data-slot="resizable-handle"
      className={cn(
        // Dark-mode audit fix: use the app's ac token system (not shadcn's
        // `bg-border`, which was near-invisible on dark surfaces) so the
        // panel separators read as structure in both themes.
        "relative flex w-px items-center justify-center bg-[var(--ac-border-default)] after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden focus-visible:ring-[var(--ac-accent)] data-[orientation=vertical]:h-px data-[orientation=vertical]:w-full data-[orientation=vertical]:after:left-0 data-[orientation=vertical]:after:h-1 data-[orientation=vertical]:after:w-full data-[orientation=vertical]:after:translate-x-0 data-[orientation=vertical]:after:-translate-y-1/2 [&[data-orientation=vertical]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-xs border bg-[var(--ac-surface-1)] ac-border-default">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </ResizableSeparatorPrimitive>
  )
}

export {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
  // Re-export the v4 hooks/types so call sites can use them without
  // importing from `react-resizable-panels` directly.
  ResizablePanelPrimitive as Panel,
  ResizableGroup as Group,
  ResizableSeparatorPrimitive as Separator,
}
export type {
  GroupProps,
  PanelProps,
  SeparatorProps,
}
