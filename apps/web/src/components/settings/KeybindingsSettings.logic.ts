import {
  STATIC_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@cogenly/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  parseKeybindingWhenExpression,
} from "@cogenly/shared/keybindings";

import { shortcutKeyFromEvent } from "../../keybindings";
import { isMacPlatform } from "../../lib/utils";

export type KeybindingSource = "Default" | "Custom" | "Repository";

export interface KeybindingRow {
  readonly id: string;
  readonly command: KeybindingCommand;
  /**
   * The row's title: the command's label, marked "(alternate)" on every binding
   * after a command's first so two rows never read the same.
   */
  readonly label: string;
  readonly key: string;
  readonly when: string;
  readonly source: KeybindingSource;
  readonly defaultKey: string | null;
  readonly defaultWhen: string;
  readonly binding: ResolvedKeybindingRule;
  readonly conflicts: ReadonlyArray<string>;
}

export type WhenVariableOption = string;
export type KeybindingCommandOption = KeybindingCommand;

const CORE_WHEN_VARIABLES = ["terminalFocus", "isWeb", "isDesktop", "true", "false"] as const;

const DEFAULT_WHEN_VARIABLES = new Set<string>(CORE_WHEN_VARIABLES);
for (const binding of DEFAULT_RESOLVED_KEYBINDINGS) {
  collectWhenIdentifiersFromNode(binding.whenAst, DEFAULT_WHEN_VARIABLES);
}

export const DEFAULT_WHEN_VARIABLE =
  [...DEFAULT_WHEN_VARIABLES].find(
    (identifier) => identifier !== "true" && identifier !== "false",
  ) ?? "terminalFocus";
const KNOWN_WHEN_VARIABLES = new Set(DEFAULT_WHEN_VARIABLES);

export function shortcutToKeybindingInput(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  parts.push(shortcut.key === " " ? "space" : shortcut.key === "escape" ? "esc" : shortcut.key);
  return parts.join("+");
}

export function whenAstToExpression(node: KeybindingWhenNode | undefined): string {
  if (!node) return "";
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${wrapWhenExpression(node.node)}`;
    case "and":
      return `${wrapWhenExpression(node.left)} && ${wrapWhenExpression(node.right)}`;
    case "or":
      return `${wrapWhenExpression(node.left)} || ${wrapWhenExpression(node.right)}`;
  }
}

export function whenNodeRemoveLabel(node: KeybindingWhenNode, depth: number): string {
  if (depth === 0) return "Clear all conditions";
  if (node.type === "identifier" || (node.type === "not" && node.node.type === "identifier")) {
    return "Remove condition";
  }
  return "Remove group and its conditions";
}

function wrapWhenExpression(node: KeybindingWhenNode): string {
  if (node.type === "identifier" || node.type === "not") return whenAstToExpression(node);
  return `(${whenAstToExpression(node)})`;
}

export function parseWhenExpressionDraft(
  expression: string,
): { ok: true; value: KeybindingWhenNode | undefined } | { ok: false; message: string } {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };

  const ast = parseKeybindingWhenExpression(trimmed);
  if (!ast) {
    return {
      ok: false,
      message: "Use variables with !, &&, ||, and parentheses.",
    };
  }

  return { ok: true, value: ast };
}

function sourceForBinding(binding: ResolvedKeybindingRule): KeybindingSource {
  if (String(binding.command).startsWith("script.")) {
    return "Repository";
  }

  const bindingKey = shortcutToKeybindingInput(binding.shortcut);
  const bindingWhen = whenAstToExpression(binding.whenAst);
  const isDefault = DEFAULT_RESOLVED_KEYBINDINGS.some(
    (entry) =>
      entry.command === binding.command &&
      shortcutToKeybindingInput(entry.shortcut) === bindingKey &&
      whenAstToExpression(entry.whenAst) === bindingWhen,
  );

  return isDefault ? "Default" : "Custom";
}

function defaultBindingForBinding(
  binding: ResolvedKeybindingRule,
): ResolvedKeybindingRule | undefined {
  const bindingKey = shortcutToKeybindingInput(binding.shortcut);
  const bindingWhen = whenAstToExpression(binding.whenAst);

  return (
    DEFAULT_RESOLVED_KEYBINDINGS.find(
      (entry) =>
        entry.command === binding.command &&
        shortcutToKeybindingInput(entry.shortcut) === bindingKey &&
        whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    DEFAULT_RESOLVED_KEYBINDINGS.find(
      (entry) =>
        entry.command === binding.command && whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    DEFAULT_RESOLVED_KEYBINDINGS.find((entry) => entry.command === binding.command)
  );
}

function keybindingRowId(command: KeybindingCommand, key: string, when: string): string {
  return `${command}\u0000${key}\u0000${when}`;
}

function conflictsWithWhen(leftWhen: string, rightWhen: string): boolean {
  return leftWhen.length === 0 || rightWhen.length === 0 || leftWhen === rightWhen;
}

export function keybindingConflictLabels(
  rows: ReadonlyArray<KeybindingRow>,
  input: { readonly rowId: string; readonly key: string; readonly when: string },
): ReadonlyArray<string> {
  if (input.key.trim().length === 0) return [];
  const conflicts: Array<string> = [];
  for (const candidate of rows) {
    if (
      candidate.id !== input.rowId &&
      candidate.key === input.key &&
      conflictsWithWhen(candidate.when, input.when)
    ) {
      conflicts.push(commandLabel(candidate.command));
    }
  }
  return [...new Set(conflicts)].toSorted();
}

export interface KeybindingGroup {
  readonly id: string;
  readonly title: string;
  readonly rows: ReadonlyArray<KeybindingRow>;
}

/** Page sections in display order; a command joins the first group listing its prefix. */
const KEYBINDING_GROUPS = [
  {
    id: "navigation",
    title: "Navigation",
    prefixes: [
      "navigation",
      "sidebar",
      "rightPanel",
      "commandPalette",
      "filePicker",
      "projectSearch",
      "editor",
      "settings",
    ],
  },
  { id: "threads", title: "Threads", prefixes: ["thread", "chat", "pullRequest"] },
  { id: "composer", title: "Composer", prefixes: ["composer"] },
  { id: "modelPicker", title: "Model picker", prefixes: ["modelPicker"] },
  { id: "preview", title: "Preview", prefixes: ["preview"] },
  { id: "appearance", title: "Appearance", prefixes: ["appearance"] },
  { id: "scripts", title: "Repository scripts", prefixes: ["script"] },
] as const;
const OTHER_KEYBINDING_GROUP = { id: "other", title: "Other" } as const;

function keybindingGroupFor(command: KeybindingCommand): { id: string; title: string } {
  const prefix = String(command).split(".")[0] ?? "";
  return (
    KEYBINDING_GROUPS.find((group) => (group.prefixes as ReadonlyArray<string>).includes(prefix)) ??
    OTHER_KEYBINDING_GROUP
  );
}

/** Splits sorted rows into the page's sections, dropping sections with no rows. */
export function groupKeybindingRows(
  rows: ReadonlyArray<KeybindingRow>,
): ReadonlyArray<KeybindingGroup> {
  const rowsByGroup = new Map<string, Array<KeybindingRow>>();
  for (const row of rows) {
    const group = keybindingGroupFor(row.command);
    const bucket = rowsByGroup.get(group.id);
    if (bucket) bucket.push(row);
    else rowsByGroup.set(group.id, [row]);
  }
  return [...KEYBINDING_GROUPS, OTHER_KEYBINDING_GROUP].flatMap((group) => {
    const groupRows = rowsByGroup.get(group.id);
    return groupRows ? [{ id: group.id, title: group.title, rows: groupRows }] : [];
  });
}

export function buildKeybindingRows(
  keybindings: ResolvedKeybindingsConfig,
  query: string,
): ReadonlyArray<KeybindingRow> {
  const normalizedQuery = query.trim().toLowerCase();
  // A command's first binding in config order is its main one; later ones are alternates.
  const listedCommands = new Set<KeybindingCommand>();
  const rows = keybindings.flatMap((binding, index) => {
    if (RETIRED_KEYBINDING_COMMANDS.has(binding.command)) return [];
    const defaultBinding = defaultBindingForBinding(binding);
    const key = shortcutToKeybindingInput(binding.shortcut);
    const when = whenAstToExpression(binding.whenAst);
    const alternate = listedCommands.has(binding.command);
    listedCommands.add(binding.command);
    return {
      id: `${keybindingRowId(binding.command, key, when)}\u0000${index}`,
      command: binding.command,
      label: alternate
        ? `${commandLabel(binding.command)} (alternate)`
        : commandLabel(binding.command),
      key,
      when,
      source: sourceForBinding(binding),
      defaultKey: defaultBinding ? shortcutToKeybindingInput(defaultBinding.shortcut) : null,
      defaultWhen: whenAstToExpression(defaultBinding?.whenAst),
      binding,
      conflicts: [],
    } satisfies KeybindingRow;
  });

  const rowsWithConflicts = rows.map((row) => {
    const conflicts = keybindingConflictLabels(rows, {
      rowId: row.id,
      key: row.key,
      when: row.when,
    });
    return conflicts.length > 0
      ? Object.assign({}, row, { conflicts: [...new Set(conflicts)].toSorted() })
      : row;
  });

  // Rows read in label order, the names people scan for. A stable sort keeps
  // one command's bindings in config order, main one first.
  rowsWithConflicts.sort(
    (left, right) =>
      commandLabel(left.command).localeCompare(commandLabel(right.command)) ||
      left.command.localeCompare(right.command),
  );

  if (normalizedQuery.length === 0) {
    return rowsWithConflicts;
  }

  return rowsWithConflicts.filter((row) => {
    return (
      row.command.toLowerCase().includes(normalizedQuery) ||
      row.label.toLowerCase().includes(normalizedQuery) ||
      row.key.toLowerCase().includes(normalizedQuery) ||
      row.when.toLowerCase().includes(normalizedQuery) ||
      (whenSummary(row.binding.whenAst)?.toLowerCase().includes(normalizedQuery) ?? false) ||
      row.source.toLowerCase().includes(normalizedQuery)
    );
  });
}

function collectWhenIdentifiersFromNode(
  node: KeybindingWhenNode | undefined,
  identifiers: Set<string>,
): void {
  if (!node) return;
  switch (node.type) {
    case "identifier":
      identifiers.add(node.name);
      return;
    case "not":
      collectWhenIdentifiersFromNode(node.node, identifiers);
      return;
    case "and":
    case "or":
      collectWhenIdentifiersFromNode(node.left, identifiers);
      collectWhenIdentifiersFromNode(node.right, identifiers);
      return;
  }
}

export function isKnownWhenVariable(identifier: string): boolean {
  return KNOWN_WHEN_VARIABLES.has(identifier);
}

export function unknownWhenVariables(node: KeybindingWhenNode | undefined): ReadonlyArray<string> {
  const identifiers = new Set<string>();
  collectWhenIdentifiersFromNode(node, identifiers);
  return [...identifiers].filter((identifier) => !isKnownWhenVariable(identifier)).toSorted();
}

export function buildWhenVariableOptions(): ReadonlyArray<WhenVariableOption> {
  return [...KNOWN_WHEN_VARIABLES].toSorted((left, right) => {
    const leftCoreIndex = CORE_WHEN_VARIABLES.indexOf(left as (typeof CORE_WHEN_VARIABLES)[number]);
    const rightCoreIndex = CORE_WHEN_VARIABLES.indexOf(
      right as (typeof CORE_WHEN_VARIABLES)[number],
    );
    if (leftCoreIndex !== -1 || rightCoreIndex !== -1) {
      return (
        (leftCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : leftCoreIndex) -
        (rightCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : rightCoreIndex)
      );
    }
    return left.localeCompare(right);
  });
}

// Still decodable so stored keybindings load, but no longer offered: user
// shells and the diff panel were removed.
export const RETIRED_KEYBINDING_COMMANDS: ReadonlySet<KeybindingCommand> = new Set([
  "diff.toggle",
  "terminal.split",
  "terminal.splitVertical",
  "terminal.new",
  "terminal.close",
]);

export function buildKeybindingCommandOptions(
  keybindings: ResolvedKeybindingsConfig,
): ReadonlyArray<KeybindingCommandOption> {
  const commands = new Set<KeybindingCommand>(STATIC_KEYBINDING_COMMANDS);
  for (const binding of keybindings) {
    commands.add(binding.command);
  }
  for (const command of RETIRED_KEYBINDING_COMMANDS) commands.delete(command);
  return [...commands].toSorted((left, right) =>
    commandLabel(left).localeCompare(commandLabel(right)),
  );
}

/** Labels the generated "Area: action" form can't produce. Sentence case, like the rest of settings. */
const COMMAND_LABELS: Partial<Record<KeybindingCommand, string>> = {
  "composer.sendAlternate": "Composer: send the other way (queue or steer)",
  "composer.sendAndNewThread": "Composer: send and start a new thread",
  "composer.sendBackground": "Composer: start in background",
  "thread.steerQueuedMessage": "Queue: send first queued message now",
  "thread.editQueuedMessage": "Queue: edit last queued message",
  "thread.sendAllQueuedMessages": "Queue: send all queued messages now",
  "thread.copyReference": "Pull request: copy link or thread ID",
  "thread.openParent": "Thread: go to parent",
  // Sidebar modes are named screens, so their names keep their capitals.
  "sidebar.mode.agents": "Sidebar: show Agents",
  "sidebar.mode.chats": "Sidebar: show Chats",
  "sidebar.mode.projects": "Sidebar: show Projects",
  // The mode id stays `tasks`; users know it as Work.
  "sidebar.mode.tasks": "Sidebar: show Work",
  "view.reopenClosed": "Reopen closed tab",
  // Kept under its old id so stored bindings still apply; it only opens an agent's settings now.
  "threadPanel.toggle": "Agent settings: open",
  "preview.focusUrl": "Preview: focus URL",
  "terminal.toggle": "Terminal panel: toggle",
  // Cogenly projects are repositories in the UI; Projects are context tags.
  "chat.newWithoutProject": "Chat: new without repository",
  "projectSearch.toggle": "Repository search: toggle",
};

export function commandLabel(command: KeybindingCommand): string {
  const fixed = COMMAND_LABELS[command];
  if (fixed) return fixed;
  const raw = String(command);
  if (raw.startsWith("script.") && raw.endsWith(".run")) {
    // Script ids are the repository's own names; show them as written.
    return `Run script: ${raw.slice("script.".length, -".run".length)}`;
  }
  const [area = "", ...action] = raw.split(".");
  const words = action.flatMap(commandSegmentWords);
  // thread.jump.1 → "Thread: jump to 1"
  if (words[0] === "jump" && words.length === 2) words.splice(1, 0, "to");
  const areaLabel = commandSegmentWords(area).join(" ");
  const label = words.length > 0 ? `${areaLabel}: ${words.join(" ")}` : areaLabel;
  return label.slice(0, 1).toUpperCase() + label.slice(1);
}

function commandSegmentWords(segment: string): Array<string> {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

/** Plain words for the conditions bindings use: [when true, when negated]. */
const WHEN_VARIABLE_PHRASES: Record<string, readonly [string, string]> = {
  terminalFocus: ["In terminal", "Outside terminal"],
  previewFocus: ["In preview", "Outside preview"],
  composerFocus: ["In composer", "Outside composer"],
  editableFocus: ["In a text field", "Outside text fields"],
  modelPickerOpen: ["Model picker open", "Model picker closed"],
  rightPanelOpen: ["Right panel open", "Right panel closed"],
  turnRunning: ["Turn running", "No turn running"],
  draftThreadRoute: ["New thread", "Existing thread"],
  isDesktop: ["Desktop app", "Browser"],
  isWeb: ["Browser", "Desktop app"],
  true: ["Always", "Never"],
  false: ["Never", "Always"],
};

function whenConditionPhrase(node: KeybindingWhenNode): string | null {
  const negated = node.type === "not";
  const target = node.type === "not" ? node.node : node;
  if (target.type !== "identifier") return null;
  const phrases = WHEN_VARIABLE_PHRASES[target.name];
  return phrases ? phrases[negated ? 1 : 0] : null;
}

function flattenWhen(node: KeybindingWhenNode, operator: "and" | "or"): KeybindingWhenNode[] {
  return node.type === operator
    ? [...flattenWhen(node.left, operator), ...flattenWhen(node.right, operator)]
    : [node];
}

/**
 * A when clause in plain words ("Outside terminal, model picker closed"), or
 * null when it mixes operators or names a condition without a phrase, so the
 * raw expression shows instead. No clause reads "Always".
 */
export function whenSummary(node: KeybindingWhenNode | undefined): string | null {
  if (!node) return "Always";
  const operator = node.type === "or" ? "or" : "and";
  const phrases = flattenWhen(node, operator).map(whenConditionPhrase);
  if (phrases.some((phrase) => phrase === null)) return null;
  const [first = "", ...rest] = phrases as string[];
  // Later phrases continue the sentence; proper names (Desktop app, Browser) read fine lowercased.
  const continued = rest.map((phrase) => phrase.slice(0, 1).toLowerCase() + phrase.slice(1));
  return [first, ...continued].join(operator === "and" ? ", " : " or ");
}

const MAC_KEYCAP_LABELS: Record<string, string> = {
  mod: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "↩",
  backspace: "⌫",
  delete: "⌦",
  esc: "Esc",
  tab: "⇥",
  space: "Space",
  pageup: "PgUp",
  pagedown: "PgDn",
};

const OTHER_KEYCAP_LABELS: Record<string, string> = {
  mod: "Ctrl",
  meta: "Meta",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "Enter",
  backspace: "Backspace",
  delete: "Del",
  esc: "Esc",
  tab: "Tab",
  space: "Space",
  pageup: "PgUp",
  pagedown: "PgDn",
};

/** One part of a binding (`mod`, `shift`, `arrowup`, `k`) as its keycap reads on this platform. */
export function keycapLabel(part: string, platform: string): string {
  const labels = isMacPlatform(platform) ? MAC_KEYCAP_LABELS : OTHER_KEYCAP_LABELS;
  const label = labels[part];
  if (label) return label;
  return part.length === 1 ? part.toUpperCase() : part.slice(0, 1).toUpperCase() + part.slice(1);
}

function normalizeShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (/^f\d{1,2}$/.test(normalized)) return normalized;
  if (normalized === "enter" || normalized === "tab" || normalized === "backspace") {
    return normalized;
  }
  if (normalized === "delete" || normalized === "home" || normalized === "end") {
    return normalized;
  }
  if (normalized === "pageup" || normalized === "pagedown") return normalized;
  return null;
}

/** Turns a keydown into a binding such as `mod+shift+k` or `tab`. Null for modifier-only presses. */
export function keybindingFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: string,
): string | null {
  const keyToken = normalizeShortcutKeyToken(shortcutKeyFromEvent(event));
  if (!keyToken) return null;

  const parts: string[] = [];
  if (isMacPlatform(platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(keyToken);
  return parts.join("+");
}
