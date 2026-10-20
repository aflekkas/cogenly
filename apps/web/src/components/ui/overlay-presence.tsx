"use client";

import { createContext, use, useMemo, useState, type ReactNode } from "react";

interface OverlayPresenceState {
  readonly open: boolean;
  readonly onExitComplete: () => void;
}

const OverlayPresenceContext = createContext<OverlayPresenceState | null>(null);

/**
 * Keeps a conditionally rendered dialog, alert dialog or sheet mounted while it
 * closes, so its exit motion plays. Render the overlay from `children` with the
 * value that opens it; the overlay inside may keep a hard-coded `open`. When
 * `when` empties, the last value stays rendered with the overlay closed until
 * its exit finishes. An overlay rendered beside another overlay inside an
 * outer presence closes when that presence does.
 *
 *   <OverlayPresence when={editing ? label : null}>
 *     {(label) => <LabelEditorDialog label={label} onClose={...} />}
 *   </OverlayPresence>
 */
export function OverlayPresence<T>({
  when,
  children,
}: {
  when: T | null | undefined | false;
  children: (value: T) => ReactNode;
}) {
  const present = when !== null && when !== undefined && when !== false;
  // Nested beside an outer presence's overlay, this one closes with it.
  const outer = use(OverlayPresenceContext);
  const open = present && (outer?.open ?? true);
  // The value last shown open, so the closing overlay keeps its content.
  const [shown, setShown] = useState<{ readonly value: T } | null>(
    present ? { value: when } : null,
  );
  if (present && shown?.value !== when) setShown({ value: when });
  const presence = useMemo<OverlayPresenceState>(
    () => ({
      open,
      onExitComplete: () => {
        if (open) return;
        if (!present) setShown(null);
        if (outer && !outer.open) outer.onExitComplete();
      },
    }),
    [open, present, outer],
  );
  if (!present && !shown) return null;
  return (
    <OverlayPresenceContext value={presence}>
      {children(present ? when : shown!.value)}
    </OverlayPresenceContext>
  );
}

/**
 * For overlay roots: closes the overlay while its OverlayPresence exits and
 * reports when the exit finished. Render the root inside
 * OverlayPresenceBoundary so a nested overlay does not read the outer presence.
 */
export function useOverlayPresenceRoot(
  open: boolean | undefined,
  onOpenChangeComplete: ((open: boolean) => void) | undefined,
) {
  const presence = use(OverlayPresenceContext);
  if (!presence) return { open, onOpenChangeComplete };
  return {
    open: presence.open ? open : false,
    onOpenChangeComplete: (next: boolean) => {
      onOpenChangeComplete?.(next);
      if (!next) presence.onExitComplete();
    },
  };
}

export function OverlayPresenceBoundary({ children }: { children: ReactNode }) {
  return <OverlayPresenceContext value={null}>{children}</OverlayPresenceContext>;
}

/**
 * The value, or while it is empty the last value it held. For the content of
 * an overlay that stays mounted and closes when its subject clears, so the
 * text does not change while it animates out.
 */
export function useLastPresent<T>(value: T | null | undefined): T | null | undefined {
  const [last, setLast] = useState(value);
  if (value !== null && value !== undefined && value !== last) setLast(value);
  return value ?? last;
}
