import { describe, expect, it } from "vite-plus/test";

import { takeLeavingCopy } from "./StateTransition.logic";

interface Entry {
  readonly source: { readonly isConnected: boolean };
  readonly copy: string;
}

const left = (copy: string): Entry => ({ source: { isConnected: false }, copy });
const hidden = (copy: string): Entry => ({ source: { isConnected: true }, copy });

function entries(group: string, entry: Entry) {
  return new Map<string, Entry>([[group, entry]]);
}

describe("takeLeavingCopy", () => {
  it("hands a removed item's copy to its replacement", () => {
    const entry = left("strip");
    const map = entries("composer-strip", entry);
    expect(takeLeavingCopy(map, "composer-strip", false)).toBe(entry);
    expect(map.size).toBe(0);
  });

  // A mode's kept-alive thread view hides in <Activity> and runs the same
  // cleanup as an unmount: its Work strip must not paint over Chats.
  it("never hands over a copy from a screen hidden but still mounted", () => {
    const map = entries("composer-strip", hidden("work strip"));
    expect(takeLeavingCopy(map, "composer-strip", false)).toBeNull();
    expect(map.size).toBe(0);
  });

  it("hands nothing over inside a mode switch's crossfade", () => {
    const map = entries("composer-strip", left("strip"));
    expect(takeLeavingCopy(map, "composer-strip", true)).toBeNull();
    expect(map.size).toBe(0);
  });

  it("returns null when nothing left that group", () => {
    expect(takeLeavingCopy(new Map<string, Entry>(), "composer-strip", false)).toBeNull();
  });
});
