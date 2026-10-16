import { BotEngine, type BotFrame } from "./engine/engine";
import { EXPRESSION_BY_ID, type BotExpression, type ExpressionId } from "./engine/expressions";
import { clamp, createRng, easings } from "./engine/math";
import { RAYON } from "./engine/repere";
import {
  COLORS,
  COLOR_BY_ID,
  SHAPES,
  SHAPE_BY_ID,
  type ColorId,
  type ShapeId,
} from "./engine/skins";
import { POSES, STATE_BY_ID, type StateId } from "./engine/states";

export type AgentFaceState =
  | "idle"
  | "thinking"
  | "working"
  | "needsYou"
  | "blocked"
  | "done"
  | "asleep"
  | "created";

export const AGENT_FACE_STATES: ReadonlyArray<AgentFaceState> = [
  "idle",
  "thinking",
  "working",
  "needsYou",
  "blocked",
  "done",
  "asleep",
  "created",
];

const ENGINE_STATE: Record<AgentFaceState, StateId> = {
  idle: "idle",
  thinking: "thinking",
  working: "orbit",
  needsYou: "notify",
  blocked: "alert",
  done: "wink",
  asleep: "sleep",
  created: "burst",
};

export function engineStateFor(state: AgentFaceState): StateId {
  return ENGINE_STATE[state];
}

export interface AgentAppearance {
  shape: ShapeId;
  color: ColorId;
  expression: ExpressionId;
  /**
   * Seconds added to the shared clock for this face. The engine's blink and gaze
   * drift are functions of time alone, so without it every face in a list would
   * blink in unison.
   */
  timeOffset: number;
}

// "encre" disappears on dark backgrounds and "creme" swallows the white eye
// holes, so seeds never land on them. Both stay available as explicit overrides.
const SEEDED_COLORS = COLORS.filter((color) => color.id !== "encre" && color.id !== "creme");

/**
 * Rest expressions a seed can land on: friendly or neutral only, so no agent
 * looks angry, sad, or scared at rest. The rest stay available as explicit
 * overrides, and `triste` is what the blocked state borrows.
 */
export const SEEDED_EXPRESSIONS: ReadonlyArray<ExpressionId> = [
  "neutre",
  "attentif",
  "curieux",
  "heureux",
  "fier",
  "excite",
  "timide",
  "somnolent",
];

/** FNV-1a: a stable 32-bit hash, so an agent keeps its face across sessions. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function pick<T>(items: ReadonlyArray<T>, roll: number): T {
  return items[Math.floor(roll * items.length) % items.length]!;
}

export function agentAppearance(seed: string): AgentAppearance {
  const next = createRng(hashSeed(seed));
  return {
    shape: pick(SHAPES, next()).id,
    color: pick(SEEDED_COLORS, next()).id,
    expression: pick(SEEDED_EXPRESSIONS, next()),
    timeOffset: next() * 60,
  };
}

/** A palette id resolves to its measured hex; anything else is used as a CSS colour. */
export function resolveFaceColor(color: string): string {
  return COLOR_BY_ID.get(color)?.hex ?? color;
}

export function shapeRadii(shape: string): number[] | null {
  return SHAPE_BY_ID.get(shape)?.radii ?? null;
}

export function faceExpression(expression: string): BotExpression | null {
  return EXPRESSION_BY_ID.get(expression) ?? null;
}

/** Idle time between two plays of a state that re-arms. */
export const REARM_REST_SECONDS = 1;

/**
 * States that play once, settle to idle, and stay there. The others with a
 * `minDuration` (orbit, alert) re-arm after a rest beat for as long as they are
 * the target.
 */
const ONE_SHOT_STATES: ReadonlySet<StateId> = new Set(["burst"]);

type DirectorPhase = "playing" | "resting" | "settled";

/**
 * Keeps a face's target state alive on the engine.
 *
 * Looping states (thinking, sleep) and held poses (notify, wink) just stay set.
 * States with a `minDuration` play once: re-arming ones (orbit, alert) rest in
 * idle for a beat after their measured `duration`, then play again; one-shot
 * ones (burst) settle to idle for good and call `onSettled`. Every change goes
 * through `setState`, so each one morphs.
 */
export class FaceDirector {
  private target: StateId;
  private phase: DirectorPhase = "playing";
  private since: number;

  constructor(
    private readonly engine: BotEngine,
    target: StateId,
    now: number,
    private readonly onSettled?: () => void,
  ) {
    this.target = target;
    this.since = now;
    engine.reset(target, now);
  }

  setTarget(target: StateId, now: number) {
    if (target === this.target && this.phase !== "resting") return;
    this.target = target;
    this.phase = "playing";
    this.since = now;
    this.engine.setState(target, now);
  }

  tick(now: number) {
    const def = STATE_BY_ID.get(this.target);
    if (!def || def.minDuration === undefined || this.phase === "settled") return;
    if (this.phase === "playing" && now - this.since >= def.duration) {
      this.phase = ONE_SHOT_STATES.has(this.target) ? "settled" : "resting";
      this.since = now;
      this.engine.setState("idle", now);
      if (this.phase === "settled") this.onSettled?.();
    } else if (this.phase === "resting" && now - this.since >= REARM_REST_SECONDS) {
      this.phase = "playing";
      this.since = now;
      this.engine.setState(this.target, now);
    }
  }
}

/** How a layered state dresses the agent's own face, and what it draws on top. */
interface StateLayer {
  expression: ExpressionId;
  indicator: StateId;
}

const STATE_LAYERS: Partial<Record<AgentFaceState, StateLayer>> = {
  thinking: { expression: "curieux", indicator: "thinking" },
  blocked: { expression: "triste", indicator: "alert" },
  asleep: { expression: "somnolent", indicator: "sleep" },
};

export function stateLayer(state: AgentFaceState): StateLayer | null {
  return STATE_LAYERS[state] ?? null;
}

/**
 * Where the indicator sits, in base engine units. Taken from the layering the
 * vanilla prototype was approved with (a 58% box at right -18%, top -20% of a
 * 316-unit avatar box), re-expressed against the ball so it keeps the same place
 * on the body under AgentFace's tighter frame: 0.58 of the ball's size, its
 * centre up and to the right, partly outside the body.
 */
const INDICATOR_SCALE = 0.58;
const INDICATOR_CENTER = { x: 1.232 * RAYON, y: -1.296 * RAYON };
/**
 * At sidebar sizes the indicator grows to 0.7 of the ball, or the sleep dot and
 * the thinking dots come out a pixel wide. It grows away from this point, its
 * corner nearest the body, so it never covers more of the face.
 */
const INDICATOR_SMALL_SCALE = 0.7;
const INDICATOR_SMALL_PX = 32;
const INDICATOR_LARGE_PX = 64;
const INDICATOR_ANCHOR = { x: 0.8 * RAYON, y: -1 * RAYON };

/** SVG transform placing the indicator layer for a face rendered at `size` px. */
export function indicatorTransform(size: number): string {
  const small = clamp((INDICATOR_LARGE_PX - size) / (INDICATOR_LARGE_PX - INDICATOR_SMALL_PX));
  const scale = INDICATOR_SCALE + (INDICATOR_SMALL_SCALE - INDICATOR_SCALE) * small;
  const grow = scale / INDICATOR_SCALE;
  const x = INDICATOR_ANCHOR.x + (INDICATOR_CENTER.x - INDICATOR_ANCHOR.x) * grow;
  const y = INDICATOR_ANCHOR.y + (INDICATOR_CENTER.y - INDICATOR_ANCHOR.y) * grow;
  return `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${scale.toFixed(3)})`;
}

/** Indicator fade in and out, in seconds. */
export const INDICATOR_FADE_SECONDS = 0.3;

/**
 * Where to restart the alert indicator's "!" when it re-arms. Its sweep ends
 * held at x = 0.1, which the next sweep passes 0.577 s in, so restarting there
 * picks the glyph up where it rests instead of snapping it back to the start.
 */
const INDICATOR_REARM_PHASE: Partial<Record<StateId, number>> = { alert: 0.577 };

/**
 * Keeps the indicator engine on its state. It has no idle to rest in (an idle
 * indicator is a second, smaller face), so states that play once (alert) hold
 * their final pose for the rest beat, then restart in place.
 */
export class IndicatorDirector {
  private target: StateId;
  private since: number;

  constructor(
    private readonly engine: BotEngine,
    target: StateId,
    now: number,
  ) {
    this.target = target;
    this.since = now;
    engine.reset(target, now);
  }

  /** Morphs to a new indicator; `restart` starts it from its first frame instead. */
  setTarget(target: StateId, now: number, restart: boolean) {
    if (target === this.target && !restart) return;
    this.target = target;
    this.since = now;
    if (restart) this.engine.reset(target, now);
    else this.engine.setState(target, now);
  }

  tick(now: number) {
    const def = STATE_BY_ID.get(this.target);
    if (!def || def.minDuration === undefined) return;
    if (now - this.since < def.duration + REARM_REST_SECONDS) return;
    const phase = INDICATOR_REARM_PHASE[this.target] ?? 0;
    this.since = now - phase;
    this.engine.reset(this.target, now - phase);
  }
}

export interface FaceRigTarget {
  state: AgentFaceState;
  /** Draw thinking, blocked, and asleep over the face instead of in place of it. */
  layered: boolean;
  radii: number[] | null;
  /** The agent's rest expression. Layered states swap in their own. */
  expression: BotExpression | null;
}

export interface FaceRigFrame {
  base: BotFrame;
  /** Null while the indicator is fully faded out. */
  indicator: BotFrame | null;
  indicatorOpacity: number;
}

/**
 * Everything that moves in one agent face: the base engine (the agent's body),
 * the indicator engine drawn over it in layered states, their directors, and the
 * indicator fade. `frame(now)` advances both directors and samples both engines,
 * so one clock tick drives the whole face. Like the engine, every change is a
 * timed setter and `frame` reads time only, so it is testable without a DOM.
 */
export class FaceRig {
  readonly base: BotEngine;
  readonly indicator: BotEngine;
  private readonly baseDirector: FaceDirector;
  private readonly indicatorDirector: IndicatorDirector;
  private fadeFrom = 0;
  private fadeTo = 0;
  private fadeAt = -Infinity;

  constructor(target: FaceRigTarget, now: number, onSettled?: () => void) {
    const layer = target.layered ? stateLayer(target.state) : null;
    this.base = new BotEngine(RAYON, "idle", target.radii, FaceRig.expressionFor(target, layer));
    this.baseDirector = new FaceDirector(
      this.base,
      layer ? "idle" : engineStateFor(target.state),
      now,
      onSettled,
    );
    this.indicator = new BotEngine(RAYON, layer?.indicator ?? "thinking");
    this.indicatorDirector = new IndicatorDirector(
      this.indicator,
      layer?.indicator ?? "thinking",
      now,
    );
    if (layer) this.fadeFrom = this.fadeTo = 1;
  }

  private static expressionFor(target: FaceRigTarget, layer: StateLayer | null) {
    return layer ? faceExpression(layer.expression) : target.expression;
  }

  update(target: FaceRigTarget, now: number) {
    const layer = target.layered ? stateLayer(target.state) : null;
    this.base.setShape(target.radii, now);
    this.base.setExpression(FaceRig.expressionFor(target, layer), now);
    this.baseDirector.setTarget(layer ? "idle" : engineStateFor(target.state), now);
    if (layer) {
      // A faded-out indicator starts its state from the top; a visible one morphs.
      this.indicatorDirector.setTarget(layer.indicator, now, this.indicatorOpacity(now) === 0);
    }
    this.fade(layer ? 1 : 0, now);
  }

  private fade(to: number, now: number) {
    if (to === this.fadeTo) return;
    this.fadeFrom = this.indicatorOpacity(now);
    this.fadeTo = to;
    this.fadeAt = now;
  }

  indicatorOpacity(now: number): number {
    const k = clamp((now - this.fadeAt) / INDICATOR_FADE_SECONDS);
    return this.fadeFrom + (this.fadeTo - this.fadeFrom) * easings.easeOutQuint(k);
  }

  frame(now: number): FaceRigFrame {
    this.baseDirector.tick(now);
    const indicatorOpacity = this.indicatorOpacity(now);
    let indicator: BotFrame | null = null;
    if (indicatorOpacity > 0) {
      this.indicatorDirector.tick(now);
      indicator = this.indicator.sample(now);
    }
    return { base: this.base.sample(now), indicator, indicatorOpacity };
  }
}

/**
 * The single frame shown under reduced motion: each engine at the pose where its
 * state reads best. `created` shows the face it settles to, since a frozen burst
 * never resolves.
 */
export function staticFaceFrame(target: FaceRigTarget): FaceRigFrame {
  const layer = target.layered ? stateLayer(target.state) : null;
  const expression = layer ? faceExpression(layer.expression) : target.expression;
  const state = layer || target.state === "created" ? "idle" : engineStateFor(target.state);
  const base = new BotEngine(RAYON, state, target.radii, expression).sample(POSES[state]);
  if (!layer) return { base, indicator: null, indicatorOpacity: 0 };
  const indicator = new BotEngine(RAYON, layer.indicator).sample(POSES[layer.indicator]);
  return { base, indicator, indicatorOpacity: 1 };
}
