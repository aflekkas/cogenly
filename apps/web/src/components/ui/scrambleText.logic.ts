/**
 * Pure timing and glyph logic for ScrambleText. While a value is pending, a
 * calm minority of its characters flicker to look-alike glyphs, each on its
 * own slow clock, so the old text stays legible. When the new value arrives
 * it resolves left to right, one character settling after another.
 */

/** Look-alike glyphs per case: narrow and even, so the line keeps its width. */
const LOWER_GLYPHS = "aceimnorsuvwxz";
const UPPER_GLYPHS = "ACENORSUVXZ";
const DIGIT_GLYPHS = "0123456789";
const SYMBOL_GLYPHS = "-·~*";

/** Share of characters scrambled at any moment while pending. */
export const SCRAMBLE_RATIO = 0.35;
/** Each character changes on its own clock, somewhere in this range. */
export const SCRAMBLE_MIN_INTERVAL_MS = 120;
export const SCRAMBLE_MAX_INTERVAL_MS = 180;
/** How long the new text takes to resolve, left to right. */
export const SCRAMBLE_RESOLVE_MS = 800;

export type RandomSource = () => number;

export interface ScrambleCell {
  /** What the cell shows now. */
  readonly char: string;
  /** Whether that is a stand-in glyph rather than the real character. */
  readonly scrambled: boolean;
  /** When this cell next changes. */
  readonly nextChangeAt: number;
}

function pick(glyphs: string, random: RandomSource): string {
  const index = Math.min(glyphs.length - 1, Math.floor(random() * glyphs.length));
  return glyphs[index]!;
}

/** A stand-in glyph in the character's own class; whitespace never scrambles. */
export function glyphFor(char: string, random: RandomSource): string | null {
  if (/\s/.test(char)) return null;
  if (/[0-9]/.test(char)) return pick(DIGIT_GLYPHS, random);
  if (char !== char.toLowerCase()) return pick(UPPER_GLYPHS, random);
  if (char !== char.toUpperCase()) return pick(LOWER_GLYPHS, random);
  return pick(SYMBOL_GLYPHS, random);
}

export function nextChangeDelay(random: RandomSource): number {
  return (
    SCRAMBLE_MIN_INTERVAL_MS + random() * (SCRAMBLE_MAX_INTERVAL_MS - SCRAMBLE_MIN_INTERVAL_MS)
  );
}

/** One cell's next state: scrambled with probability `ratio`, otherwise its real character. */
function rollCell(char: string, now: number, random: RandomSource, ratio: number): ScrambleCell {
  const glyph = random() < ratio ? glyphFor(char, random) : null;
  return {
    char: glyph ?? char,
    scrambled: glyph !== null,
    nextChangeAt: now + nextChangeDelay(random),
  };
}

/** Fresh cells for `source`, staggered so they never change in step. */
export function initScrambleCells(
  source: string,
  now: number,
  random: RandomSource,
  ratio: number = SCRAMBLE_RATIO,
): ScrambleCell[] {
  return Array.from(source, (char) => rollCell(char, now, random, ratio));
}

/**
 * Advances the pending scramble to `now` against `source` (which may have
 * changed length). Only cells whose clock is due change; `changed` says
 * whether anything did, so the caller can skip a render.
 */
export function stepScrambleCells(
  cells: readonly ScrambleCell[],
  source: string,
  now: number,
  random: RandomSource,
  ratio: number = SCRAMBLE_RATIO,
): { cells: ScrambleCell[]; changed: boolean } {
  const chars = Array.from(source);
  let changed = chars.length !== cells.length;
  const next = chars.map((char, index) => {
    const cell = cells[index];
    if (cell && now < cell.nextChangeAt) {
      // Keep the cell, but never let it show a stale real character.
      if (!cell.scrambled && cell.char !== char) {
        changed = true;
        return { ...cell, char };
      }
      return cell;
    }
    changed = true;
    return rollCell(char, now, random, ratio);
  });
  return { cells: next, changed };
}

/** How many leading characters of a `length`-long target have resolved. */
export function resolvedCharacterCount(
  length: number,
  elapsedMs: number,
  durationMs: number = SCRAMBLE_RESOLVE_MS,
): number {
  if (length <= 0) return 0;
  if (durationMs <= 0 || elapsedMs >= durationMs) return length;
  if (elapsedMs <= 0) return 0;
  return Math.min(length, Math.floor((elapsedMs / durationMs) * length));
}

/**
 * One step of the resolve from `from` (the text shown while pending) into
 * `target`: the first characters have settled on the target for good, the
 * rest still show the old text with its slow scramble, so the new text wipes
 * in left to right. `done` once every character has settled.
 */
export function resolveScrambleCells(
  cells: readonly ScrambleCell[],
  from: string,
  target: string,
  elapsedMs: number,
  now: number,
  random: RandomSource,
  durationMs: number = SCRAMBLE_RESOLVE_MS,
): { cells: ScrambleCell[]; changed: boolean; done: boolean } {
  const chars = Array.from(target);
  const fromChars = Array.from(from);
  const resolved = resolvedCharacterCount(chars.length, elapsedMs, durationMs);
  const base = chars.map((char, index) => (index < resolved ? char : (fromChars[index] ?? char)));
  const stepped = stepScrambleCells(cells, base.join(""), now, random);
  let changed = stepped.changed;
  const next = stepped.cells.map((cell, index) => {
    if (index >= resolved) return cell;
    const char = chars[index]!;
    if (!cell.scrambled && cell.char === char && cell.nextChangeAt === Number.POSITIVE_INFINITY) {
      return cell;
    }
    changed = true;
    return { char, scrambled: false, nextChangeAt: Number.POSITIVE_INFINITY };
  });
  return { cells: next, changed, done: resolved >= chars.length };
}
