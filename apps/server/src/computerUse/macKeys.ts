/** macOS virtual key codes (ANSI layout) for `computer_key`. */
const KEY_CODES: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "=": 24,
  "9": 25,
  "7": 26,
  "-": 27,
  "8": 28,
  "0": 29,
  "]": 30,
  o: 31,
  u: 32,
  "[": 33,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  "'": 39,
  k: 40,
  ";": 41,
  "\\": 42,
  ",": 43,
  "/": 44,
  n: 45,
  m: 46,
  ".": 47,
  "`": 50,
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  forwarddelete: 117,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

const MODIFIER_FLAGS: Record<string, number> = {
  cmd: 0x100000,
  command: 0x100000,
  meta: 0x100000,
  super: 0x100000,
  shift: 0x20000,
  option: 0x80000,
  opt: 0x80000,
  alt: 0x80000,
  ctrl: 0x40000,
  control: 0x40000,
  fn: 0x800000,
};

export interface KeyCombo {
  readonly keyCode: number;
  readonly flags: number;
}

/** Parses `cmd+shift+t`, `return` or `ctrl+a`. Undefined when a part is unknown. */
export function parseKeyCombo(input: string): KeyCombo | undefined {
  const text = input.trim().toLowerCase();
  // A trailing "+" is the plus key itself (shift and "="), as in "cmd++".
  const plus = text === "+" || text.endsWith("++");
  const parts = (plus ? text.slice(0, -1) : text)
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const key = plus ? "=" : parts.pop();
  if (key === undefined) return undefined;
  let flags = plus ? MODIFIER_FLAGS.shift! : 0;
  for (const modifier of parts) {
    const flag = MODIFIER_FLAGS[modifier];
    if (flag === undefined) return undefined;
    flags |= flag;
  }
  const keyCode = KEY_CODES[key];
  return keyCode === undefined ? undefined : { keyCode, flags };
}
