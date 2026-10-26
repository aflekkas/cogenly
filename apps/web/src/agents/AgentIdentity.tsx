import { ChevronRightIcon, ChevronLeftIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { AgentFace, type AgentFaceProps } from "~/components/agents/face";
import { Button } from "~/components/ui/button";
import { prefersReducedMotion } from "~/lib/sendMotion";
import { cn } from "~/lib/utils";
import { isElectron } from "~/env";

/**
 * The person at the top of a conversation, as a messaging app pins them: the face
 * (which follows the pointer and blinks on its own) and the name in a pill that opens
 * Details, with the status inline while there is one. It floats over the transcript
 * on a frosted band; the header controls sit at the corners. `person` replaces the
 * default face and name, for a page that renders its own (the builder).
 */
export function AgentIdentity({
  face,
  name,
  status,
  onBack,
  onDetails,
  trailing,
  person,
}: {
  face: AgentFaceProps;
  name: string;
  /** Shown inline after the name; pass nothing while idle. */
  status?: string | null;
  onBack?: (() => void) | undefined;
  /** Opens Details; without it the name pill is plain text. */
  onDetails?: (() => void) | undefined;
  /** The header controls at the top right, such as the Details popover's icon. */
  trailing?: ReactNode;
  person?: ReactNode;
}) {
  return (
    <header className={cn("agent-identity", isElectron && "drag-region")}>
      <span aria-hidden className="agent-identity-backdrop" />
      <div className="flex items-center [-webkit-app-region:no-drag]">
        {onBack ? (
          <Button size="icon-sm" variant="ghost-muted" aria-label="Back to agents" onClick={onBack}>
            <ChevronLeftIcon className="size-4.5" />
          </Button>
        ) : null}
      </div>
      {person ?? (
        <AgentIdentityPerson face={face} name={name} status={status} onDetails={onDetails} />
      )}
      <div className="flex items-center justify-end gap-1 [-webkit-app-region:no-drag]">
        {trailing}
      </div>
    </header>
  );
}

/**
 * The face over the name pill. `hero` is the same person at a larger scale, for an
 * empty conversation that introduces the agent before it moves into the header; the
 * pill scales as a whole, so one can be drawn exactly over the other mid-move.
 */
export function AgentIdentityPerson({
  ref,
  face,
  name,
  status,
  onDetails,
  size = "header",
  hidden = false,
  morphName = false,
}: {
  ref?: Ref<HTMLDivElement>;
  face: AgentFaceProps;
  name: string;
  status?: string | null | undefined;
  onDetails?: (() => void) | undefined;
  size?: "header" | "hero";
  /** Keeps its place while something else shows the person. */
  hidden?: boolean;
  /** Fades a new name in where it sits; for names that change while on screen. */
  morphName?: boolean;
}) {
  const statusLine = status ? (
    <span key={status} className="agent-identity-status agent-morph" role="status">
      {status}
    </span>
  ) : null;
  const label = (
    <span key={morphName ? name : undefined} className={morphName ? "agent-morph" : undefined}>
      {name}
    </span>
  );
  const pill = useRef<HTMLElement | null>(null);
  const setPill = useCallback((node: HTMLElement | null) => {
    pill.current = node;
  }, []);
  usePillWidthMotion(pill, `${name}\u0000${status ?? ""}`, hidden);
  return (
    <div
      ref={ref}
      className="agent-identity-person"
      data-size={size}
      data-hidden={hidden || undefined}
      aria-hidden={hidden || undefined}
    >
      <span className="agent-identity-face">
        <AgentFace {...face} size={size === "hero" ? 72 : 36} />
      </span>
      {onDetails ? (
        <button ref={setPill} type="button" className="agent-identity-name" onClick={onDetails}>
          {label}
          {statusLine}
          <ChevronRightIcon className="size-3" aria-hidden />
        </button>
      ) : (
        <span ref={setPill} className="agent-identity-name">
          {label}
          {statusLine}
        </span>
      )}
    </div>
  );
}

/** A motion token from index.css, as a number of milliseconds or a timing function. */
export function motionToken(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Eases the pill's width when its text changes (a name arriving, a status coming
 * or going) while the new text fades in where it sits. The pill clips its text
 * until it lands. Snaps under reduced motion, and while the person is hidden.
 */
function usePillWidthMotion(pill: RefObject<HTMLElement | null>, content: string, hidden: boolean) {
  const shown = useRef<{ content: string; width: number } | null>(null);
  const motion = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const element = pill.current;
    if (!element) return;
    const last = shown.current;
    // Mid-move the pill is still at its animated width; start from there.
    const from = motion.current ? element.offsetWidth : last?.width;
    motion.current?.cancel();
    motion.current = null;
    element.toggleAttribute("data-resizing", false);
    const to = element.offsetWidth;
    shown.current = { content, width: to };
    if (
      from === undefined ||
      last?.content === content ||
      Math.abs(from - to) < 0.5 ||
      hidden ||
      typeof element.animate !== "function" ||
      prefersReducedMotion()
    )
      return;
    element.toggleAttribute("data-resizing", true);
    const animation = element.animate([{ width: `${from}px` }, { width: `${to}px` }], {
      duration: Number.parseFloat(motionToken("--motion-duration-base", "200")),
      easing: motionToken("--motion-ease-standard", "cubic-bezier(0.32, 0.72, 0, 1)"),
    });
    motion.current = animation;
    animation.addEventListener(
      "finish",
      () => {
        if (motion.current !== animation) return;
        motion.current = null;
        element.toggleAttribute("data-resizing", false);
      },
      { once: true },
    );
  }, [content, hidden, pill]);
  useEffect(() => () => motion.current?.cancel(), []);
}
