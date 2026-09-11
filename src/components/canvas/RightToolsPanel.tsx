'use client';

// RightToolsPanel — tools-focused right panel for the three-zone layout.
// Replaces the existing RightTabbedPanel with a tab strip oriented toward
// design tooling: Layers (default), Properties, Design Systems, Assets.
//
// Tab strip follows the same Material 3 "active indicator" pattern used by
// the existing RightTabbedPanel (full-width pill with --ac-accent-soft fill).
// Container query hides tab labels below 12rem (icon-only mode).

import { LayersPanel } from './LayersPanel';
import { PropertiesPanel } from './PropertiesPanel';
import {
  Layers as LayersIcon,
  Sliders,
  Boxes,
  Palette,
  PanelRightClose,
  PanelLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

export type RightTab = 'layers' | 'properties' | 'design-systems' | 'assets';

export interface RightToolsPanelProps {
  tab: RightTab;
  onTabChange: (t: RightTab) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const tabs: {
  id: RightTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'layers', label: 'Layers', icon: LayersIcon },
  { id: 'properties', label: 'Properties', icon: Sliders },
  { id: 'design-systems', label: 'Design Systems', icon: Palette },
  { id: 'assets', label: 'Assets', icon: Boxes },
];

// Inline Design Systems panel — shows a header, description, and a button
// that opens the existing DesignSystemPicker dialog via CustomEvent.
function DesignSystemsPanel() {
  const openPicker = () => {
    window.dispatchEvent(new CustomEvent('agentcanvas:open-design-systems'));
  };

  return (
    <div className="flex flex-col h-full p-4 gap-4">
      <h3 className="text-sm font-semibold ac-text-1">Design Systems</h3>
      <p className="text-xs ac-text-3">Select a design system pack for the agent to use when generating UI.</p>
      <Button
        variant="outline"
        size="sm"
        onClick={openPicker}
        className="self-start"
      >
        <Palette className="h-3.5 w-3.5 mr-1.5" />
        Open Picker
      </Button>
    </div>
  );
}

export function RightToolsPanel({
  tab,
  onTabChange,
  collapsed,
  onToggleCollapse,
}: RightToolsPanelProps) {
  return (
    <div
      className={`@container flex flex-col h-full ac-surface-0 ac-hide-scrollbar overflow-hidden min-w-0 ${collapsed ? 'hidden' : ''}`}
    >
      {/* Tab strip — Material 3 active indicator pattern. */}
      <div className="flex items-center gap-1 px-1.5 py-1.5 border-b ac-border-subtle ac-surface-0 flex-shrink-0">
        <div className="flex gap-0.5 flex-1 min-w-0" role="tablist" aria-label="Right tools panel">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                aria-controls={`right-tools-tab-${t.id}`}
                onClick={() => onTabChange(t.id)}
                title={t.label}
                className={`relative flex items-center gap-1.5 px-2.5 h-7 rounded-md text-[11px] font-medium ac-transition ac-focus-ring ${
                  active
                    ? 'bg-[var(--ac-accent-soft)] ac-text-1'
                    : 'ac-text-3 hover:ac-text-1 hover:ac-surface-1'
                }`}
              >
                <Icon className="h-3 w-3" />
                <span className="hidden @min-[12rem]:inline">{t.label}</span>
              </button>
            );
          })}
        </div>

        {/* Collapse chevron */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleCollapse}
          title="Toggle right panel (⌘2)"
          aria-label="Toggle right panel"
          className="h-7 w-7 p-0 ac-text-3 hover:ac-text-1 hover:ac-surface-1 ac-transition ac-focus-ring flex-shrink-0"
        >
          {collapsed ? (
            <PanelLeft className="h-3.5 w-3.5" />
          ) : (
            <PanelRightClose className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {/* Active panel body */}
      <div className="flex-1 min-h-0">
        {tab === 'layers' && <LayersPanel tab="layers" />}
        {tab === 'properties' && <PropertiesPanel />}
        {tab === 'design-systems' && <DesignSystemsPanel />}
        {tab === 'assets' && <LayersPanel tab="assets" />}
      </div>
    </div>
  );
}
