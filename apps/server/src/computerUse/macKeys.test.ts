import { describe, expect, it } from "@effect/vitest";

import { parseKeyCombo } from "./macKeys.ts";

const CMD = 0x100000;
const SHIFT = 0x20000;

describe("parseKeyCombo", () => {
  it("parses plain keys and shortcuts", () => {
    expect(parseKeyCombo("return")).toEqual({ keyCode: 36, flags: 0 });
    expect(parseKeyCombo("cmd+,")).toEqual({ keyCode: 43, flags: CMD });
    expect(parseKeyCombo("Cmd + Shift + T")).toEqual({ keyCode: 17, flags: CMD | SHIFT });
  });

  it("reads a trailing plus as the plus key", () => {
    expect(parseKeyCombo("cmd++")).toEqual({ keyCode: 24, flags: CMD | SHIFT });
  });

  it("rejects unknown keys and modifiers", () => {
    expect(parseKeyCombo("hyper+a")).toBeUndefined();
    expect(parseKeyCombo("cmd+banana")).toBeUndefined();
    expect(parseKeyCombo("")).toBeUndefined();
  });
});
