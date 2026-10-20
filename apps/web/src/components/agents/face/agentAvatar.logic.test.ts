import { describe, expect, it } from "vite-plus/test";

import {
  AVATAR_COLOR_OPTIONS,
  AVATAR_EXPRESSION_OPTIONS,
  AVATAR_SHAPE_OPTIONS,
  avatarFace,
  avatarFaceProps,
  paletteColorId,
  shuffledAvatar,
  withAvatarPart,
} from "./agentAvatar.logic";
import { agentAppearance } from "./agentFace.logic";
import { COLORS, SHAPES } from "./engine/skins";
import { EXPRESSIONS } from "./engine/expressions";

describe("avatarFace", () => {
  it("resolves a seed-only avatar to the face the seed has always given", () => {
    const seeded = agentAppearance("legacy-seed");
    expect(avatarFace({ seed: "legacy-seed" })).toEqual({
      shape: seeded.shape,
      color: seeded.color,
      expression: seeded.expression,
    });
  });

  it("keeps a stored custom colour that is outside the palette", () => {
    expect(avatarFace({ seed: "juniper", color: "#90b79c" }).color).toBe("#90b79c");
  });

  it("falls back to the seed for shape and expression ids it does not know", () => {
    const seeded = agentAppearance("future");
    const face = avatarFace({ seed: "future", shape: "star", expression: "smug" });
    expect(face.shape).toBe(seeded.shape);
    expect(face.expression).toBe(seeded.expression);
  });

  it("uses pinned parts it knows", () => {
    expect(avatarFace({ seed: "x", shape: "nuage", expression: "fier", color: "bleu" })).toEqual({
      shape: "nuage",
      color: "bleu",
      expression: "fier",
    });
  });
});

describe("avatarFaceProps", () => {
  it("drops unknown ids so the face renders the seed's pick", () => {
    expect(avatarFaceProps({ seed: "s", shape: "star", expression: "heureux" })).toEqual({
      seed: "s",
      expression: "heureux",
    });
  });
});

describe("withAvatarPart", () => {
  it("pins every part and keeps the seed when one part is picked", () => {
    const seeded = agentAppearance("pick");
    expect(withAvatarPart({ seed: "pick" }, { shape: "goutte" })).toEqual({
      seed: "pick",
      shape: "goutte",
      color: seeded.color,
      expression: seeded.expression,
    });
  });

  it("keeps earlier picks when another part changes", () => {
    const first = withAvatarPart({ seed: "pick" }, { color: "rose" });
    const second = withAvatarPart(first, { expression: "timide" });
    expect(avatarFace(second)).toEqual({ ...avatarFace(first), expression: "timide" });
  });

  it("replaces a stored part the client does not know", () => {
    expect(withAvatarPart({ seed: "s", shape: "star" }, { shape: "capsule" }).shape).toBe(
      "capsule",
    );
  });
});

describe("shuffledAvatar", () => {
  it("clears every pin so the new seed decides the face", () => {
    expect(shuffledAvatar("fresh")).toEqual({ seed: "fresh" });
  });
});

describe("paletteColorId", () => {
  it("matches palette ids and their hex, in any case", () => {
    expect(paletteColorId("ambre")).toBe("ambre");
    expect(paletteColorId("#F0B429")).toBe("ambre");
  });

  it("is null for colours outside the palette", () => {
    expect(paletteColorId("#90b79c")).toBeNull();
  });
});

describe("picker options", () => {
  it("offers every shape, expression and colour the engine has", () => {
    expect(AVATAR_SHAPE_OPTIONS.map((option) => option.id)).toEqual(SHAPES.map((s) => s.id));
    expect(AVATAR_EXPRESSION_OPTIONS.map((option) => option.id)).toEqual(
      EXPRESSIONS.map((e) => e.id),
    );
    expect(AVATAR_COLOR_OPTIONS.map((option) => option.id)).toEqual(COLORS.map((c) => c.id));
  });
});
