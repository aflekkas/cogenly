import { describe, expect, it } from "@effect/vitest";
import type { AnimationEvent } from "react";

import { synchronizeTerminalPulse } from "./ThreadStatusIndicators";

describe("synchronizeTerminalPulse", () => {
  it("pins only the status pulse to the document clock", () => {
    const pulse = { animationName: "status-pulse", startTime: 975 } as CSSAnimation;
    const otherCss = { animationName: "other-animation", startTime: 125 } as CSSAnimation;
    const otherAnimation = { startTime: 250 } as Animation;

    synchronizeTerminalPulse({
      animationName: "status-pulse",
      currentTarget: { getAnimations: () => [pulse, otherCss, otherAnimation] },
    } as AnimationEvent<SVGSVGElement>);

    expect([pulse.startTime, otherCss.startTime, otherAnimation.startTime]).toEqual([0, 125, 250]);
  });
});
