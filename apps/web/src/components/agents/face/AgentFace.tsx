import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, type Ref } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";

import {
  FaceRig,
  agentAppearance,
  faceExpression,
  indicatorTransform,
  resolveFaceColor,
  shapeRadii,
  staticFaceFrame,
  type AgentFaceState,
  type FaceRigFrame,
  type FaceRigTarget,
} from "./agentFace.logic";
import { NOTIF_BLUE } from "./engine/decor";
import type { ExpressionId } from "./engine/expressions";
import { DEMI_VIEWBOX } from "./engine/repere";
import type { ShapeId } from "./engine/skins";
import { faceClockNow, observeFaceVisibility, subscribeFaceClock } from "./faceClock";
import { FacePainter } from "./facePainter";

/**
 * Half-size of the visible box, in engine units (ball radius = 100). Tighter than
 * bloub's 158 so the ball fills the avatar at sidebar sizes; the SVG overflows, so
 * orbit rings and burst particles that reach past it still draw.
 */
const FRAME = 120;
const VB = DEMI_VIEWBOX;
// Mask luminance, not theme colours: white keeps the body, black punches a hole.
const MASK_KEEP = "#fff";
const MASK_HOLE = "#000";

export interface AgentFaceProps {
  /** Stable agent id. Picks shape, colour, and rest expression when not overridden. */
  seed: string;
  shape?: ShapeId;
  /** A palette id (`bleu`, `encre`, ...) or any CSS colour. */
  color?: string;
  /** Rest expression. Layered states swap in their own while they last. */
  expression?: ExpressionId;
  state?: AgentFaceState;
  /**
   * Thinking, blocked, and asleep keep the agent's face (with a matching
   * expression) and draw the state as a small indicator at its top right, which
   * reaches about 0.25 × size past the right and top edges: leave room or keep
   * ancestors at `overflow: visible`. `false` plays those states full-body, as
   * bloub does. Default `true`.
   */
  layered?: boolean;
  /** Called once `created` has played and the face has settled to idle. */
  onSettled?: () => void;
  /** Rendered width and height, in px. */
  size?: number;
  /** Colour seen through the eye holes. */
  paper?: string;
  /** Accessible name. Without it the face is decorative. */
  label?: string;
  className?: string;
}

interface FacePainters {
  base: FacePainter;
  indicator: FacePainter;
}

function paintFrame(painters: FacePainters, frame: FaceRigFrame) {
  painters.base.paint(frame.base);
  painters.indicator.fade(frame.indicatorOpacity);
  if (frame.indicator) painters.indicator.paint(frame.indicator);
}

export const AgentFace = memo(function AgentFace({
  seed,
  shape,
  color,
  expression,
  state = "idle",
  layered = true,
  onSettled,
  size = 32,
  paper = "#ffffff",
  label,
  className,
}: AgentFaceProps) {
  const seeded = useMemo(() => agentAppearance(seed), [seed]);
  const radii = shapeRadii(shape ?? seeded.shape);
  const expr = faceExpression(expression ?? seeded.expression);
  const ink = resolveFaceColor(color ?? seeded.color);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  const uid = `agent-face-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const baseRef = useRef<SVGGElement>(null);
  const indicatorRef = useRef<SVGGElement>(null);
  const onSettledRef = useRef(onSettled);
  useLayoutEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);
  const live = useRef<{
    seed: string;
    offset: number;
    rig: FaceRig;
    painters: FacePainters;
  } | null>(null);

  // One rig per face (and per seed). Prop changes reach it as timed setters, so
  // shape, expression, state, and layering changes all morph or fade.
  useLayoutEffect(() => {
    const target: FaceRigTarget = { state, layered, radii, expression: expr };
    let face = live.current;
    const offset = seeded.timeOffset;
    const now = faceClockNow() + offset;
    if (!face || face.seed !== seed) {
      face = {
        seed,
        offset,
        rig: new FaceRig(target, now, () => onSettledRef.current?.()),
        painters: {
          base: new FacePainter(baseRef.current!, uid, ink),
          indicator: new FacePainter(indicatorRef.current!, `${uid}-i`, ink),
        },
      };
      live.current = face;
    } else {
      face.rig.update(target, now);
      face.painters.base.ink = ink;
      face.painters.indicator.ink = ink;
    }
    // Static pose for reduced motion, and the first frame before the clock ticks.
    paintFrame(face.painters, reducedMotion ? staticFaceFrame(target) : face.rig.frame(now));
  }, [seed, seeded, uid, radii, expr, state, layered, ink, reducedMotion]);

  // Reduced motion shows `created` already settled.
  useEffect(() => {
    if (reducedMotion && state === "created") onSettledRef.current?.();
  }, [reducedMotion, state]);

  useEffect(() => {
    if (reducedMotion) return;
    const element = baseRef.current!.ownerSVGElement!;
    let unsubscribe: (() => void) | null = null;
    // One clock subscription per face; both layers are sampled in the same tick.
    const onFrame = (clock: number) => {
      const face = live.current;
      if (face) paintFrame(face.painters, face.rig.frame(clock + face.offset));
    };
    const stopObserving = observeFaceVisibility(element, (visible) => {
      if (visible && !unsubscribe) unsubscribe = subscribeFaceClock(onFrame);
      if (!visible && unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    });
    return () => {
      stopObserving();
      unsubscribe?.();
    };
  }, [reducedMotion]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-FRAME} ${-FRAME} ${FRAME * 2} ${FRAME * 2}`}
      overflow="visible"
      className={className}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <FaceLayer ref={baseRef} uid={uid} ink={ink} paper={paper} />
      <g transform={indicatorTransform(size)}>
        {/* Transparent paper: the indicator is ink only, drawn straight over the face. */}
        <FaceLayer ref={indicatorRef} uid={`${uid}-i`} ink={ink} paper="none" />
      </g>
    </svg>
  );
});

/**
 * The SVG skeleton one engine paints into. Layering follows bloub's
 * `BloubBot.vue`; `FacePainter` fills in the geometry every frame.
 */
function FaceLayer({
  ref,
  uid,
  ink,
  paper,
}: {
  ref: Ref<SVGGElement>;
  uid: string;
  ink: string;
  paper: string;
}) {
  const maskId = `${uid}-mask`;
  return (
    <g ref={ref}>
      <defs>
        {/* The eyes are holes in the body, so they clip against its outline. */}
        <mask id={maskId} maskUnits="userSpaceOnUse" x={-VB} y={-VB} width={VB * 2} height={VB * 2}>
          <path data-part="mask-body" fill={MASK_KEEP} />
          <path data-part="eye" fill={MASK_HOLE} />
          <path data-part="eye" fill={MASK_HOLE} />
          <circle data-part="notch" fill={MASK_HOLE} />
        </mask>
      </defs>
      <defs data-part="gradients" />
      <g data-part="arcs-back" fill="none" strokeLinecap="round" />
      <g data-part="dots-behind" />
      <g data-part="body">
        {/* Opaque backing so arcs and particles drawn behind the body never show through the eyes. */}
        <path data-part="paper" fill={paper} />
        <g mask={`url(#${maskId})`}>
          <rect x={-VB} y={-VB} width={VB * 2} height={VB * 2} fill={ink} />
        </g>
      </g>
      <g data-part="dots-front" />
      <circle data-part="notif" fill={NOTIF_BLUE} />
      <g data-part="arcs-front" fill="none" strokeLinecap="round" />
    </g>
  );
}
