import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";

import { observeResize } from "~/lib/observeResize";
import { ComposerBanner } from "./ComposerBanner";
import {
  budgetComposerStack,
  composerStackCap,
  sameFolds,
  type ComposerStackPanel,
} from "./composerStackBudget.logic";

const NO_FOLDS: ReadonlySet<string> = new Set();
const LIST_MAX_PROPERTY = "--composer-stack-list-max";
// The current copy only: a notice cross-fading out keeps its markup, inert.
const BODY_SELECTOR = "[data-composer-stack-body]:not([inert] *)";

interface ComposerStackFolds {
  readonly folded: ReadonlySet<string>;
  readonly reveal: (id: string) => void;
}

const ComposerStackFoldContext = createContext<ComposerStackFolds>({
  folded: NO_FOLDS,
  reveal: () => {},
});

/**
 * Marks the wrapper around a panel's open list (the element that opens and
 * closes) so the stack can budget it. `rank` orders folding: lower folds first.
 * `open` is the user's choice, not whether the stack has folded it.
 */
export function composerStackBodyProps(id: string, rank: number, open: boolean) {
  return {
    "data-composer-stack-body": id,
    "data-composer-stack-rank": rank,
    "data-composer-stack-open": open ? "true" : "false",
  };
}

/**
 * Whether the stack folded this panel's list to its header to fit. A panel
 * shows its list only when the user opened it and it is not folded; its header
 * calls `reveal` instead of toggling while folded, so a click always opens it.
 */
export function useComposerStackFold(id: string) {
  const { folded, reveal } = useContext(ComposerStackFoldContext);
  const revealThis = useCallback(() => reveal(id), [reveal, id]);
  return { folded: folded.has(id), reveal: revealThis };
}

/** Finite motion still playing inside the stack; a looping pulse never settles. */
function runningMotion(element: HTMLElement) {
  return element
    .getAnimations({ subtree: true })
    .filter(
      (animation) =>
        animation.playState === "running" &&
        animation.effect?.getComputedTiming().endTime !== Infinity,
    );
}

/**
 * The column of panels above the composer, held to about a third of the chat
 * pane. Over budget, open lists scroll inside their panels; when that would
 * leave a list too short to read, the least important open list folds to its
 * header. Panels marked `data-composer-stack-blocking` (a question waiting on
 * the user) count against the budget but never shrink or fold.
 *
 * Measuring waits for running open, close and swap motion to settle, so a
 * panel mid-rise never reads as short and a fold is decided once, not
 * replayed every frame.
 */
export function ComposerStackColumn({
  children,
  ...props
}: ComponentProps<typeof ComposerBanner.Column>) {
  const columnRef = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(NO_FOLDS);
  // Full list heights, kept while a list is folded and its rows are unmounted.
  const naturalHeightsRef = useRef(new Map<string, number>());
  const pinnedIdRef = useRef<string | null>(null);
  const measureRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const column = columnRef.current;
    const pane = column?.closest<HTMLElement>('[data-chat-composer-overlay="true"]')?.parentElement;
    if (!column || !pane) return;
    let waiting = false;
    let frame: number | null = null;
    let disposed = false;

    const measure = () => {
      if (disposed || waiting) return;
      const motion = runningMotion(column);
      if (motion.length > 0) {
        waiting = true;
        void Promise.allSettled(motion.map((animation) => animation.finished)).then(() => {
          waiting = false;
          measure();
        });
        return;
      }
      const panels: ComposerStackPanel[] = [];
      const bodies = new Map<string, HTMLElement>();
      let stackedHeight = 0;
      for (const child of column.children) {
        if (!(child instanceof HTMLElement)) continue;
        const height = child.getBoundingClientRect().height;
        if (height <= 0) continue;
        stackedHeight += height;
        const blocking = child.hasAttribute("data-composer-stack-blocking");
        const body = blocking ? null : child.querySelector<HTMLElement>(BODY_SELECTOR);
        const id = body?.dataset.composerStackBody;
        if (!body || !id) {
          panels.push({
            id: `fixed:${panels.length}`,
            kind: blocking ? "blocking" : "notice",
            rank: 0,
            chromeHeight: height,
            bodyHeight: 0,
          });
          continue;
        }
        bodies.set(id, body);
        const open = body.dataset.composerStackOpen === "true";
        const viewport = body.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
        if (open && viewport) naturalHeightsRef.current.set(id, viewport.scrollHeight);
        if (!open && pinnedIdRef.current === id) pinnedIdRef.current = null;
        panels.push({
          id,
          kind: "list",
          rank: Number(body.dataset.composerStackRank ?? 0),
          pinned: pinnedIdRef.current === id,
          chromeHeight: Math.max(0, height - body.getBoundingClientRect().height),
          bodyHeight: open ? (naturalHeightsRef.current.get(id) ?? 0) : 0,
        });
      }
      if (pinnedIdRef.current !== null && !bodies.has(pinnedIdRef.current)) {
        pinnedIdRef.current = null;
      }
      // Attachments tuck under one another; the overlap covers no chat.
      const overlap = Math.max(0, stackedHeight - column.getBoundingClientRect().height);
      const budget = budgetComposerStack(panels, composerStackCap(pane.clientHeight) + overlap);
      for (const [id, body] of bodies) {
        const max = budget.bodyMax.get(id);
        if (max === undefined) body.style.removeProperty(LIST_MAX_PROPERTY);
        else body.style.setProperty(LIST_MAX_PROPERTY, `${max}px`);
      }
      setFolded((current) => (sameFolds(current, budget.folded) ? current : budget.folded));
    };
    measureRef.current = measure;

    // Rows arriving in a list that is already capped change no size.
    const mutations = new MutationObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    });
    mutations.observe(column, { childList: true, subtree: true });
    const stopObserving = observeResize([column, pane], measure);
    return () => {
      disposed = true;
      stopObserving();
      mutations.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      measureRef.current = () => {};
    };
  }, []);

  const reveal = useCallback((id: string) => {
    pinnedIdRef.current = id;
    measureRef.current();
  }, []);
  const folds = useMemo(() => ({ folded, reveal }), [folded, reveal]);

  return (
    <ComposerStackFoldContext value={folds}>
      <ComposerBanner.Column ref={columnRef} {...props}>
        {children}
      </ComposerBanner.Column>
    </ComposerStackFoldContext>
  );
}
