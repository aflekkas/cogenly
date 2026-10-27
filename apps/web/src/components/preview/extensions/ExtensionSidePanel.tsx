import type { BrowserExtension, PreviewSessionSnapshot, ScopedThreadRef } from "@cogenly/contracts";
import { XIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { EdgeResizeHandle } from "~/components/EdgeResizeHandle";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "~/hooks/useResizableWidth";

import { ToolbarButton } from "../PreviewChromeRow";
import { BrowserExtensionIcon } from "./BrowserExtensionIcon";
import { ExtensionSurface } from "./ExtensionSurface";

const SIDE_PANEL_WIDTH = { default: 360, min: 260, max: 640 } as const;

/**
 * An extension's side panel: a column beside the page with the extension's
 * name and a close button, resized from its left edge. One per tab.
 */
export function ExtensionSidePanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: PreviewSessionSnapshot;
  /** Null until the extension list arrives. */
  readonly extension: BrowserExtension | null;
  readonly visible: boolean;
  readonly onClose: () => void;
}) {
  const { width, handlers } = useResizableWidth({
    storageKey: "cogenly:browser-extension-side-panel-width",
    defaultWidth: SIDE_PANEL_WIDTH.default,
    minWidth: SIDE_PANEL_WIDTH.min,
    maxWidth: SIDE_PANEL_WIDTH.max,
    edge: "left",
  });
  const name = props.extension?.name ?? "Extension";
  return (
    <section
      aria-label={`${name} side panel`}
      className="relative flex w-(--resizable-width) min-w-0 shrink-0 flex-col border-l border-border/60 bg-background"
      style={{ [RESIZABLE_WIDTH_PROPERTY]: `${width}px` } as CSSProperties}
    >
      <EdgeResizeHandle edge="left" handlers={handlers} aria-label={`Resize ${name} side panel`} />
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 ps-3 pe-1">
        {props.extension ? <BrowserExtensionIcon extension={props.extension} /> : null}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
        <ToolbarButton
          label={`Close ${name} side panel`}
          tooltip="Close side panel"
          onClick={props.onClose}
        >
          <XIcon />
        </ToolbarButton>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ExtensionSurface
          threadRef={props.threadRef}
          snapshot={props.snapshot}
          visible={props.visible}
        />
      </div>
    </section>
  );
}
