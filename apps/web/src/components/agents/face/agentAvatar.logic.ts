import type { AgentAvatar } from "@cogenly/contracts";

import { agentAppearance } from "./agentFace.logic";
import { EXPRESSIONS, EXPRESSION_BY_ID, type ExpressionId } from "./engine/expressions";
import {
  COLORS,
  COLOR_BY_ID,
  SHAPES,
  SHAPE_BY_ID,
  type ColorId,
  type ShapeId,
} from "./engine/skins";

/** The parts of a face an owner can pick. `color` is a palette id or any CSS colour. */
export interface AvatarFace {
  shape: ShapeId;
  color: string;
  expression: ExpressionId;
}

export type AvatarPart = Partial<AvatarFace>;

const isShape = (value: string | undefined): value is ShapeId =>
  value !== undefined && SHAPE_BY_ID.has(value);
const isExpression = (value: string | undefined): value is ExpressionId =>
  value !== undefined && EXPRESSION_BY_ID.has(value);

/**
 * The face an avatar shows: each pinned part the client knows, the seed's pick
 * for the rest. An avatar saved before parts could be pinned is just its seed.
 */
export function avatarFace(avatar: AgentAvatar): AvatarFace {
  const seeded = agentAppearance(avatar.seed);
  return {
    shape: isShape(avatar.shape) ? avatar.shape : seeded.shape,
    color: avatar.color ?? seeded.color,
    expression: isExpression(avatar.expression) ? avatar.expression : seeded.expression,
  };
}

/** AgentFace props for an avatar. Unknown shape or expression ids fall back to the seed. */
export function avatarFaceProps(avatar: AgentAvatar): {
  seed: string;
  shape?: ShapeId;
  color?: string;
  expression?: ExpressionId;
} {
  return {
    seed: avatar.seed,
    ...(isShape(avatar.shape) ? { shape: avatar.shape } : {}),
    ...(avatar.color ? { color: avatar.color } : {}),
    ...(isExpression(avatar.expression) ? { expression: avatar.expression } : {}),
  };
}

/**
 * The avatar with `part` picked. The seed stays, since it also staggers the
 * face's blinks, and every part is pinned so the face no longer depends on
 * how a seed resolves.
 */
export function withAvatarPart(avatar: AgentAvatar, part: AvatarPart): AgentAvatar {
  const face = { ...avatarFace(avatar), ...part };
  return { seed: avatar.seed, shape: face.shape, color: face.color, expression: face.expression };
}

/** A fresh seed with nothing pinned. */
export function shuffledAvatar(seed: string): AgentAvatar {
  return { seed };
}

/** The palette entry a colour is, by id or by hex. Null for colours outside the palette. */
export function paletteColorId(color: string): ColorId | null {
  const byId = COLOR_BY_ID.get(color);
  if (byId) return byId.id;
  const hex = color.trim().toLowerCase();
  return COLORS.find((entry) => entry.hex === hex)?.id ?? null;
}

const SHAPE_LABELS: Record<ShapeId, string> = {
  cercle: "Circle",
  galet: "Pebble",
  squircle: "Squircle",
  capsule: "Capsule",
  triangle: "Triangle",
  hexagone: "Hexagon",
  nuage: "Cloud",
  goutte: "Drop",
};

const EXPRESSION_LABELS: Record<ExpressionId, string> = {
  neutre: "Neutral",
  attentif: "Attentive",
  surpris: "Surprised",
  excite: "Excited",
  heureux: "Happy",
  hilare: "Delighted",
  colere: "Cross",
  triste: "Sad",
  effraye: "Scared",
  mefiant: "Wary",
  confus: "Confused",
  curieux: "Curious",
  fier: "Proud",
  timide: "Shy",
  blase: "Unimpressed",
  somnolent: "Sleepy",
};

const COLOR_LABELS: Record<ColorId, string> = {
  encre: "Ink",
  creme: "Cream",
  brun: "Brown",
  rouge: "Red",
  orange: "Orange",
  ambre: "Amber",
  vert: "Green",
  turquoise: "Teal",
  bleu: "Blue",
  violet: "Violet",
  rose: "Pink",
  gris: "Grey",
};

export interface AvatarOption<Id extends string> {
  id: Id;
  label: string;
}

export const AVATAR_SHAPE_OPTIONS: ReadonlyArray<AvatarOption<ShapeId>> = SHAPES.map((shape) => ({
  id: shape.id,
  label: SHAPE_LABELS[shape.id],
}));

export const AVATAR_EXPRESSION_OPTIONS: ReadonlyArray<AvatarOption<ExpressionId>> = EXPRESSIONS.map(
  (expression) => ({
    id: expression.id,
    label: EXPRESSION_LABELS[expression.id],
  }),
);

export const AVATAR_COLOR_OPTIONS: ReadonlyArray<AvatarOption<ColorId> & { hex: string }> =
  COLORS.map((color) => ({ id: color.id, label: COLOR_LABELS[color.id], hex: color.hex }));
