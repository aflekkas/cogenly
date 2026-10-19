import { describe, expect, it, vi } from "vite-plus/test";

import {
  AGENT_FACE_STATES,
  FaceDirector,
  FaceRig,
  GAZE_RELEASE_SECONDS,
  INDICATOR_FADE_SECONDS,
  IndicatorDirector,
  REARM_REST_SECONDS,
  SEEDED_EXPRESSIONS,
  BLINK_MIN_SECONDS,
  BLINK_SPREAD_SECONDS,
  agentAppearance,
  blinkSchedule,
  engineStateFor,
  faceExpression,
  eyesInsideBody,
  gazeFit,
  gazeLook,
  gazeToward,
  indicatorTransform,
  resolveFaceColor,
  shapeRadii,
  staticFaceFrame,
  type AgentFaceState,
  type FaceRigTarget,
} from "./agentFace.logic";
import { BotEngine, type BotFrame } from "./engine/engine";
import { EXPRESSIONS } from "./engine/expressions";
import { SHAPES } from "./engine/skins";
import { STATE_BY_ID } from "./engine/states";

const seeds = Array.from({ length: 400 }, (_, index) => `agent-${index}`);

describe("agentAppearance", () => {
  it("gives the same face to the same seed", () => {
    expect(agentAppearance("thread-42")).toEqual(agentAppearance("thread-42"));
  });

  it("spreads seeds across every shape", () => {
    const shapes = new Set(seeds.map((seed) => agentAppearance(seed).shape));
    expect(shapes).toEqual(new Set(SHAPES.map((shape) => shape.id)));
  });

  it("never seeds the near-black or cream colours", () => {
    const colors = new Set(seeds.map((seed) => agentAppearance(seed).color));
    expect(colors.has("encre")).toBe(false);
    expect(colors.has("creme")).toBe(false);
    expect(colors.size).toBe(10);
  });

  it("seeds only friendly or neutral rest expressions, and all of them", () => {
    const expressions = new Set(seeds.map((seed) => agentAppearance(seed).expression));
    expect(expressions).toEqual(new Set(SEEDED_EXPRESSIONS));
    for (const unfriendly of ["triste", "effraye", "colere", "mefiant", "blase"] as const) {
      expect(expressions.has(unfriendly)).toBe(false);
    }
  });

  it("keeps every expression available as an explicit override", () => {
    for (const expression of EXPRESSIONS) {
      expect(faceExpression(expression.id)).toBe(expression);
    }
  });

  it("keeps palette ids and raw CSS colours both usable as overrides", () => {
    expect(resolveFaceColor("encre")).toBe("#0a0a0c");
    expect(resolveFaceColor("oklch(0.7 0.1 200)")).toBe("oklch(0.7 0.1 200)");
  });
});

describe("engineStateFor", () => {
  it("maps every agent state onto an engine state", () => {
    expect(Object.fromEntries(AGENT_FACE_STATES.map((s) => [s, engineStateFor(s)]))).toEqual({
      idle: "idle",
      thinking: "thinking",
      working: "orbit",
      needsYou: "notify",
      blocked: "alert",
      done: "wink",
      asleep: "sleep",
      created: "burst",
    });
  });
});

describe("FaceDirector", () => {
  const statesOver = (director: FaceDirector, engine: BotEngine, from: number, until: number) => {
    const seen: string[] = [];
    for (let now = from; now <= until; now += 1 / 60) {
      director.tick(now);
      if (seen.at(-1) !== engine.state) seen.push(engine.state);
    }
    return seen;
  };

  it("keeps looping and held states set", () => {
    for (const target of ["thinking", "notify", "wink", "sleep"] as const) {
      const engine = new BotEngine();
      const director = new FaceDirector(engine, target, 10);
      expect(statesOver(director, engine, 10, 40)).toEqual([target]);
    }
  });

  it.each(["orbit", "alert"] as const)("re-arms %s after a rest beat", (target) => {
    const engine = new BotEngine();
    const director = new FaceDirector(engine, target, 5);
    const duration = STATE_BY_ID.get(target)!.duration;
    const cycle = duration + REARM_REST_SECONDS;
    expect(statesOver(director, engine, 5, 5 + cycle * 2 + 0.5)).toEqual([
      target,
      "idle",
      target,
      "idle",
      target,
    ]);
  });

  it("plays burst once, settles to idle, and reports it once", () => {
    const engine = new BotEngine();
    const onSettled = vi.fn();
    const director = new FaceDirector(engine, "burst", 5, onSettled);
    expect(statesOver(director, engine, 5, 30)).toEqual(["burst", "idle"]);
    expect(onSettled).toHaveBeenCalledTimes(1);
    // Re-rendering with the same state does not replay it...
    director.setTarget("burst", 31);
    expect(engine.state).toBe("idle");
    // ...but a new `created` after another state does.
    director.setTarget("orbit", 32);
    director.setTarget("burst", 33);
    expect(engine.state).toBe("burst");
  });

  it("switches straight to a new target while resting", () => {
    const engine = new BotEngine();
    const director = new FaceDirector(engine, "alert", 0);
    director.tick(3);
    expect(engine.state).toBe("idle");
    director.setTarget("thinking", 3.2);
    expect(engine.state).toBe("thinking");
    director.setTarget("alert", 3.4);
    director.tick(3.5);
    expect(engine.state).toBe("alert");
  });
});

describe("IndicatorDirector", () => {
  it("re-arms alert without going through idle or snapping the glyph back", () => {
    const engine = new BotEngine();
    const director = new IndicatorDirector(engine, "alert", 0);
    let last = engine.sample(0).dots[0]!.x;
    let biggestJump = 0;
    let rearms = 0;
    for (let now = 0; now <= 12; now += 1 / 60) {
      const before = engine.state;
      director.tick(now);
      expect(engine.state).toBe(before);
      const x = engine.sample(now).dots[0]!.x;
      if (Math.abs(x - last) > 1e-9 && now > 2.4 + REARM_REST_SECONDS) rearms++;
      biggestJump = Math.max(biggestJump, Math.abs(x - last));
      last = x;
    }
    expect(rearms).toBeGreaterThan(0);
    // Two frames of the sweep at its fastest move the dot ~3 units; a snap back to
    // the start would move it ~19.
    expect(biggestJump).toBeLessThan(4);
  });
});

describe("FaceRig", () => {
  const target = (state: AgentFaceState, layered = true): FaceRigTarget => ({
    state,
    layered,
    radii: shapeRadii("hexagone"),
    expression: faceExpression("heureux"),
  });

  it("samples both engines once per frame in layered states", () => {
    const rig = new FaceRig(target("thinking"), 0);
    const base = vi.spyOn(rig.base, "sample");
    const indicator = vi.spyOn(rig.indicator, "sample");
    for (let frame = 1; frame <= 10; frame++) rig.frame(frame / 60);
    expect(base).toHaveBeenCalledTimes(10);
    expect(indicator).toHaveBeenCalledTimes(10);
  });

  it.each([
    ["thinking", "curieux", "thinking"],
    ["blocked", "triste", "alert"],
    ["asleep", "somnolent", "sleep"],
  ] as const)(
    "keeps the face idle for %s, with its expression, under the indicator",
    (state, expression, indicator) => {
      const rig = new FaceRig(target(state), 0);
      const frame = rig.frame(1);
      expect(rig.base.state).toBe("idle");
      expect(rig.indicator.state).toBe(indicator);
      expect(frame.indicator).not.toBeNull();
      expect(frame.indicatorOpacity).toBe(1);
      // The face keeps its eyes, which the full-body states fade out.
      expect(frame.base.eyes.every((eye) => eye.alpha > 0)).toBe(true);
      const reference = new BotEngine(
        100,
        "idle",
        shapeRadii("hexagone"),
        faceExpression(expression),
      );
      reference.restsStill = true;
      expect(frame.base.bodyPath).toBe(reference.sample(1).bodyPath);
    },
  );

  it("plays the bloub full-body states when not layered", () => {
    const rig = new FaceRig(target("thinking", false), 0);
    const indicator = vi.spyOn(rig.indicator, "sample");
    const frame = rig.frame(1);
    expect(rig.base.state).toBe("thinking");
    expect(frame.indicator).toBeNull();
    expect(indicator).not.toHaveBeenCalled();
  });

  it("leaves non-layered states to the base engine", () => {
    const rig = new FaceRig(target("working"), 0);
    expect(rig.base.state).toBe("orbit");
    expect(rig.frame(1).indicator).toBeNull();
  });

  it("fades the indicator in and out, and stops sampling it once hidden", () => {
    const rig = new FaceRig(target("idle"), 0);
    const indicator = vi.spyOn(rig.indicator, "sample");
    rig.update(target("blocked"), 1);
    expect(rig.base.state).toBe("idle");
    expect(rig.indicator.state).toBe("alert");
    const midIn = rig.frame(1 + INDICATOR_FADE_SECONDS / 4).indicatorOpacity;
    expect(midIn).toBeGreaterThan(0);
    expect(midIn).toBeLessThan(1);
    expect(rig.frame(2).indicatorOpacity).toBe(1);

    rig.update(target("working"), 3);
    expect(rig.base.state).toBe("orbit");
    const midOut = rig.frame(3 + INDICATOR_FADE_SECONDS / 4).indicatorOpacity;
    expect(midOut).toBeGreaterThan(0);
    expect(midOut).toBeLessThan(1);
    indicator.mockClear();
    expect(rig.frame(4).indicator).toBeNull();
    expect(indicator).not.toHaveBeenCalled();
  });

  it("morphs the base expression into and out of a layered state", () => {
    const rig = new FaceRig(target("idle"), 0);
    const restEyes = rig.frame(2).base.eyes.map((eye) => eye.d);
    rig.update(target("asleep"), 2);
    const sleepyEyes = rig.frame(5).base.eyes.map((eye) => eye.d);
    expect(sleepyEyes).not.toEqual(restEyes);
    // Mid-morph, the eyes are neither the old nor the new expression.
    rig.update(target("idle"), 5);
    const between = rig.frame(5.05).base.eyes.map((eye) => eye.d);
    expect(between).not.toEqual(restEyes);
    expect(between).not.toEqual(sleepyEyes);
  });

  it("morphs between indicators while visible", () => {
    const rig = new FaceRig(target("thinking"), 0);
    rig.update(target("blocked"), 1);
    expect(rig.indicator.state).toBe("alert");
    expect(rig.frame(1.05).indicatorOpacity).toBe(1);
  });

  it("settles created to idle by itself and calls back", () => {
    const onSettled = vi.fn();
    const rig = new FaceRig(target("created"), 0, onSettled);
    for (let now = 0; now < 10; now += 1 / 60) rig.frame(now);
    expect(rig.base.state).toBe("idle");
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});

describe("FaceRig at rest", () => {
  const idle: FaceRigTarget = {
    state: "idle",
    layered: true,
    radii: shapeRadii("goutte"),
    expression: faceExpression("curieux"),
  };
  const settleTime = (rig: FaceRig, from: number) => {
    for (let now = from; now < from + 10; now += 1 / 60) {
      if (rig.frame(now).settled) return now;
    }
    return Infinity;
  };

  it("settles once idle and then draws the same frame forever", () => {
    const rig = new FaceRig(idle, 0);
    const at = settleTime(rig, 0);
    expect(at).toBeLessThan(1);
    const still = rig.frame(at).base;
    for (const later of [at + 0.7, at + 3.4, at + 61]) {
      const frame = rig.frame(later);
      expect(frame.settled).toBe(true);
      expect(frame.base).toEqual(still);
    }
  });

  it("wakes for a blink, closes its eyes, and settles again", () => {
    const rig = new FaceRig(idle, 0);
    const open = rig.frame(5).base;
    rig.blink(5);
    const mid = rig.frame(5.1);
    expect(mid.settled).toBe(false);
    expect(mid.base.eyes.map((eye) => eye.matrix)).not.toEqual(open.eyes.map((eye) => eye.matrix));
    const at = settleTime(rig, 5.1);
    expect(at).toBeLessThan(5.5);
    expect(rig.frame(at).base).toEqual(open);
  });

  it("wakes for a gaze change and settles on it, and again on release", () => {
    const rig = new FaceRig(idle, 0);
    const rest = rig.frame(5).base;
    rig.setGaze(gazeToward(400, -100, 32), 5);
    expect(rig.frame(5).settled).toBe(false);
    const looked = settleTime(rig, 5);
    expect(looked).toBeLessThan(5 + BotEngine.LOOK_MORPH + 0.05);
    expect(rig.frame(looked).base).not.toEqual(rest);
    rig.setGaze(null, 7);
    expect(rig.frame(7.1).settled).toBe(false);
    const released = settleTime(rig, 7);
    expect(released).toBeLessThan(7 + GAZE_RELEASE_SECONDS + 0.05);
    expect(rig.frame(released).base).toEqual(rest);
  });

  it("wakes for a prop change and settles after the morph", () => {
    const rig = new FaceRig(idle, 0);
    rig.update({ ...idle, radii: shapeRadii("cercle"), expression: faceExpression("fier") }, 5);
    expect(rig.frame(5.1).settled).toBe(false);
    expect(settleTime(rig, 5)).toBeLessThan(5 + BotEngine.SHAPE_MORPH + 0.05);
  });

  it("settles after created plays, and after a layered state fades out", () => {
    const rig = new FaceRig({ ...idle, state: "created" }, 0);
    expect(settleTime(rig, 0)).toBeLessThan(STATE_BY_ID.get("burst")!.duration + 1);
    rig.update({ ...idle, state: "thinking" }, 20);
    expect(rig.frame(22).settled).toBe(false);
    rig.update(idle, 23);
    expect(settleTime(rig, 23)).toBeLessThan(23 + 0.5);
  });

  it.each(["thinking", "working", "blocked", "done", "asleep"] as const)(
    "keeps animating while %s",
    (state) => {
      const rig = new FaceRig({ ...idle, state }, 0);
      expect(settleTime(rig, 0)).toBe(Infinity);
    },
  );

  it("keeps blinks a few seconds apart, staggered per seed", () => {
    const next = blinkSchedule("agent-1");
    const first = next();
    expect(first).toBeLessThan(BLINK_MIN_SECONDS + BLINK_SPREAD_SECONDS);
    for (let index = 0; index < 20; index++) {
      const delay = next();
      expect(delay).toBeGreaterThanOrEqual(BLINK_MIN_SECONDS);
      expect(delay).toBeLessThan(BLINK_MIN_SECONDS + BLINK_SPREAD_SECONDS);
    }
    const firsts = new Set(seeds.slice(0, 20).map((seed) => blinkSchedule(seed)()));
    expect(firsts.size).toBe(20);
  });
});

describe("staticFaceFrame", () => {
  it("draws the face and the indicator for layered states", () => {
    const frame = staticFaceFrame({
      state: "blocked",
      layered: true,
      radii: null,
      expression: null,
    });
    expect(frame.indicator).not.toBeNull();
    expect(frame.base.eyes.every((eye) => eye.alpha > 0)).toBe(true);
  });

  it("shows created already settled", () => {
    const frame = staticFaceFrame({
      state: "created",
      layered: true,
      radii: null,
      expression: null,
    });
    expect(frame.base.dots).toEqual([]);
    expect(frame.indicator).toBeNull();
  });
});

describe("indicatorTransform", () => {
  it("uses the prototype's placement at large sizes and grows it at sidebar sizes", () => {
    expect(indicatorTransform(96)).toBe("translate(123.2 -129.6) scale(0.580)");
    expect(indicatorTransform(64)).toBe(indicatorTransform(96));
    expect(indicatorTransform(28)).toBe(indicatorTransform(32));
    expect(indicatorTransform(32)).toMatch(/scale\(0\.700\)$/);
  });
});

describe("gazeToward", () => {
  it("looks straight out when the pointer is on the face's centre", () => {
    expect(gazeToward(0, 0, 32)).toEqual({ x: 0, y: 0 });
  });

  it("turns right and up toward a pointer up and to the right", () => {
    const look = gazeLook(gazeToward(200, -200, 32));
    expect(look.yaw).toBeGreaterThan(0);
    expect(look.pitch).toBeGreaterThan(0);
    expect(look.leanX).toBeGreaterThan(0);
    expect(look.leanY).toBeLessThan(0);
    const mirrored = gazeLook(gazeToward(-200, 200, 32));
    expect(mirrored.yaw).toBeCloseTo(-look.yaw);
    expect(mirrored.pitch).toBeCloseTo(-look.pitch);
  });

  it("looks further the further away the pointer is, up to full reach", () => {
    const near = gazeToward(40, 0, 32).x;
    const far = gazeToward(400, 0, 32).x;
    expect(near).toBeLessThan(far);
    expect(far).toBeLessThan(gazeToward(1e7, 0, 32).x);
    for (let angle = 0; angle < Math.PI * 2; angle += 0.3) {
      const gaze = gazeToward(Math.cos(angle) * 1e7, Math.sin(angle) * 1e7, 32);
      expect(Math.hypot(gaze.x, gaze.y)).toBeCloseTo(1);
    }
  });

  it("needs the pointer further away for a big face than a small one", () => {
    expect(gazeToward(150, 0, 160).x).toBeLessThan(gazeToward(150, 0, 24).x);
  });
});

describe("FaceRig gaze", () => {
  const settled = 30;
  const rigFor = (shape: string, expression: string) =>
    new FaceRig(
      {
        state: "idle",
        layered: true,
        radii: shapeRadii(shape),
        expression: faceExpression(expression),
      },
      0,
    );
  const eyeX = (frame: BotFrame) => {
    const matrix = frame.eyes[0]!.matrix.slice(7, -1).split(",").map(Number);
    return matrix[4]!;
  };

  it("keeps both eye holes inside the body at full reach in every direction", () => {
    const clipped: string[] = [];
    for (const shape of SHAPES) {
      for (const expression of SEEDED_EXPRESSIONS) {
        // Twice as many directions as the fit measures, so in-between ones are covered too.
        for (let step = 0; step < 24; step++) {
          const angle = (step / 24) * Math.PI * 2;
          const rig = rigFor(shape.id, expression);
          rig.setGaze(gazeToward(Math.cos(angle) * 1e7, Math.sin(angle) * 1e7, 32), settled);
          for (const t of [settled + 1, settled + 2.3, settled + 4.1]) {
            if (!eyesInsideBody(rig.frame(t).base))
              clipped.push(`${shape.id} ${expression} ${step}`);
          }
        }
      }
    }
    expect(clipped).toEqual([]);
  });

  it("gives round shapes the full reach and narrow ones less", () => {
    const round = gazeFit(shapeRadii("cercle"), faceExpression("neutre"));
    const cloud = gazeFit(shapeRadii("nuage"), faceExpression("timide"));
    expect(Math.min(...round)).toBeGreaterThan(0.8);
    expect(Math.min(...cloud)).toBeLessThan(Math.min(...round));
    expect(Math.min(...cloud)).toBeGreaterThan(0);
  });

  it("eases toward a new target and settles on it", () => {
    const rig = rigFor("cercle", "neutre");
    const start = eyeX(rig.frame(settled).base);
    rig.setGaze(gazeToward(1e7, 0, 32), settled);
    const midway = eyeX(rig.frame(settled + BotEngine.LOOK_MORPH / 4).base);
    const end = eyeX(rig.frame(settled + BotEngine.LOOK_MORPH).base);
    const later = eyeX(rig.frame(settled + BotEngine.LOOK_MORPH + 0.5).base);
    expect(midway).not.toBeCloseTo(start, 1);
    expect(Math.abs(midway - end)).toBeGreaterThan(0.1);
    expect(Math.abs(later - end)).toBeLessThan(1.5);
  });

  it("looks left of a pointer to its left", () => {
    const left = rigFor("cercle", "neutre");
    const right = rigFor("cercle", "neutre");
    left.setGaze(gazeToward(-500, 0, 32), settled);
    right.setGaze(gazeToward(500, 0, 32), settled);
    const t = settled + 1;
    expect(eyeX(left.frame(t).base)).toBeLessThan(eyeX(right.frame(t).base) - 20);
  });

  it("eases back to its own gaze when the pointer is released", () => {
    const free = rigFor("cercle", "neutre");
    const rig = rigFor("cercle", "neutre");
    rig.setGaze(gazeToward(-1e7, 0, 32), settled);
    rig.setGaze(null, settled + 1);
    const released = settled + 1 + GAZE_RELEASE_SECONDS;
    expect(rig.frame(released).base.eyes[0]!.matrix).toBe(
      free.frame(released).base.eyes[0]!.matrix,
    );
  });

  it("leaves non-idle states their own eyes, and picks the pointer back up after", () => {
    const target: FaceRigTarget = {
      state: "done",
      layered: true,
      radii: null,
      expression: null,
    };
    const tracked = new FaceRig(target, 0);
    const free = new FaceRig(target, 0);
    tracked.setGaze(gazeToward(-1e7, 0, 32), 0);
    expect(tracked.frame(2).base.eyes[0]?.matrix).toBe(free.frame(2).base.eyes[0]?.matrix);
    tracked.update({ ...target, state: "idle" }, 3);
    free.update({ ...target, state: "idle" }, 3);
    tracked.frame(4);
    expect(eyeX(tracked.frame(6).base)).toBeLessThan(eyeX(free.frame(6).base) - 20);
  });
});
