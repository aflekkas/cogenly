import { describe, expect, it } from "vite-plus/test";
import type { ResolvedKeybindingsConfig } from "@cogenly/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@cogenly/shared/keybindings";

import {
  buildKeybindingRows,
  buildKeybindingCommandOptions,
  buildWhenVariableOptions,
  commandLabel,
  groupKeybindingRows,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
  keycapLabel,
  parseWhenExpressionDraft,
  shortcutToKeybindingInput,
  unknownWhenVariables,
  whenAstToExpression,
  whenNodeRemoveLabel,
  whenSummary,
} from "./KeybindingsSettings.logic";

describe("KeybindingsSettings.logic", () => {
  it("lists composer, provider, and thread commands with editable defaults", () => {
    const rows = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "");
    for (const command of [
      "composer.sendAlternate",
      "composer.sendBackground",
      "thread.steerQueuedMessage",
      "thread.editQueuedMessage",
      "composer.host",
      "composer.effort",
      "composer.mode",
      "composer.workspace",
      "composer.branch",
      "composer.previousWorktree",
      "modelPicker.previousProvider",
      "modelPicker.nextProvider",
      "thread.copyReference",
    ]) {
      expect(rows.find((row) => row.command === command)).toMatchObject({
        source: "Default",
        conflicts: [],
      });
    }
  });
  it("finds the editable shortcut for sending the first queued message", () => {
    expect(buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "first queued")).toContainEqual(
      expect.objectContaining({
        command: "thread.steerQueuedMessage",
        key: "mod+shift+enter",
      }),
    );
  });
  it.each(["pu", "pull request", "copy link", "thread id"])(
    "finds the copy link shortcut with %s",
    (query) => {
      const rows = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, query);
      expect(rows).toContainEqual(
        expect.objectContaining({ command: "thread.copyReference", key: "mod+shift+c" }),
      );
    },
  );
  it("groups rows by command area in page order and drops empty groups", () => {
    const groups = groupKeybindingRows(buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, ""));
    expect(groups.map((group) => group.title)).toEqual([
      "Navigation",
      "Threads",
      "Composer",
      "Model picker",
      "Preview",
      "Appearance",
      "Other",
    ]);
    const composer = groups.find((group) => group.id === "composer");
    expect(composer?.rows.map((row) => row.command)).toEqual(
      expect.arrayContaining(["composer.host"]),
    );
    expect(composer?.rows.some((row) => row.command.startsWith("modelPicker."))).toBe(false);
    const modelPicker = groups.find((group) => group.id === "modelPicker");
    expect(modelPicker?.rows.map((row) => row.command)).toEqual(
      expect.arrayContaining(["modelPicker.toggle", "modelPicker.jump.1"]),
    );
    expect(
      groupKeybindingRows(buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "preview.toggle")),
    ).toEqual([expect.objectContaining({ id: "preview" })]);
  });
  it("builds searchable rows with readable key and when values", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "preview.toggle",
          shortcut: {
            key: "j",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "preview",
    );

    expect(rows).toEqual([
      expect.objectContaining({
        command: "preview.toggle",
        key: "mod+j",
        when: "!terminalFocus",
        defaultKey: "mod+shift+j",
        defaultWhen: "",
        source: "Custom",
      }),
    ]);
  });

  it("hides stored bindings for the retired shell commands but offers the panel toggle", () => {
    const shortcut = {
      key: "n",
      modKey: true,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    const retired = {
      command: "terminal.new",
      shortcut,
    } satisfies ResolvedKeybindingsConfig[number];
    expect(buildKeybindingRows([retired], "")).toEqual([]);
    expect(buildKeybindingCommandOptions([retired])).not.toContain("terminal.new");
    expect(buildKeybindingCommandOptions([])).toContain("terminal.toggle");
  });

  it("captures platform-specific mod shortcuts", () => {
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", code: "KeyK", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
        "MacIntel",
      ),
    ).toBe("mod+shift+k");
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", code: "KeyK", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        "Win32",
      ),
    ).toBe("mod+shift+k");
  });

  it.each([
    ["k", "KeyK", "k"],
    ["Tab", "Tab", "tab"],
    ["F5", "F5", "f5"],
  ])("captures %s without a modifier", (key, code, expected) => {
    const noModifiers = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(keybindingFromKeyboardEvent({ key, code, ...noModifiers }, "MacIntel")).toBe(expected);
  });

  it("waits for a key when only a modifier is pressed", () => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key: "Meta",
          code: "MetaLeft",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBeNull();
  });

  it.each([
    ["@", "Digit2", "mod+shift+2"],
    ['"', "Digit2", "mod+shift+2"],
    ["@", "Quote", "mod+shift+'"],
  ])("captures %s at %s by physical key", (key, code, expected) => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key,
          code,
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
        },
        "MacIntel",
      ),
    ).toBe(expected);
  });

  it("captures Latin layout keys instead of their punctuation position", () => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key: "m",
          code: "Semicolon",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe("mod+m");
  });

  it("serializes shortcuts and when expressions for upserts", () => {
    expect(
      shortcutToKeybindingInput({
        key: " ",
        modKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      }),
    ).toBe("mod+alt+space");

    expect(
      whenAstToExpression({
        type: "and",
        left: { type: "identifier", name: "editorFocus" },
        right: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      }),
    ).toBe("editorFocus && !terminalFocus");

    expect(parseWhenExpressionDraft("editorFocus && (!terminalFocus || modelPickerOpen)")).toEqual({
      ok: true,
      value: {
        type: "and",
        left: { type: "identifier", name: "editorFocus" },
        right: {
          type: "or",
          left: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
          right: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
    expect(parseWhenExpressionDraft("editorFocus &&")).toEqual({
      ok: false,
      message: "Use variables with !, &&, ||, and parentheses.",
    });

    expect(parseWhenExpressionDraft("!(terminalFocus || modelPickerOpen)")).toEqual({
      ok: true,
      value: {
        type: "not",
        node: {
          type: "or",
          left: { type: "identifier", name: "terminalFocus" },
          right: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
  });

  it("describes the scope of each visual expression removal", () => {
    const condition = { type: "identifier", name: "terminalFocus" } as const;
    const negatedCondition = { type: "not", node: condition } as const;
    const group = { type: "and", left: condition, right: negatedCondition } as const;
    const negatedGroup = { type: "not", node: group } as const;

    expect(whenNodeRemoveLabel(group, 0)).toBe("Clear all conditions");
    expect(whenNodeRemoveLabel(condition, 1)).toBe("Remove condition");
    expect(whenNodeRemoveLabel(negatedCondition, 1)).toBe("Remove condition");
    expect(whenNodeRemoveLabel(group, 1)).toBe("Remove group and its conditions");
    expect(whenNodeRemoveLabel(negatedGroup, 1)).toBe("Remove group and its conditions");
  });

  it("formats static and project script command labels", () => {
    expect(commandLabel("commandPalette.toggle")).toBe("Command palette: toggle");
    expect(commandLabel("modelPicker.previousProvider")).toBe("Model picker: previous provider");
    expect(commandLabel("thread.jump.3")).toBe("Thread: jump to 3");
    expect(commandLabel("sidebar.mode.tasks")).toBe("Sidebar: show Work");
    expect(commandLabel("view.reopenClosed")).toBe("Reopen closed tab");
    expect(commandLabel("preview.focusUrl")).toBe("Preview: focus URL");
    expect(commandLabel("script.setup-db.run")).toBe("Run script: setup-db");
  });

  it("gives every default row a distinct title, main binding first", () => {
    const rows = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "");
    expect(new Set(rows.map((row) => row.label)).size).toBe(rows.length);
    const chatNew = rows.filter((row) => row.command === "chat.new");
    expect(chatNew.map((row) => [row.label, row.key])).toEqual([
      ["Chat: new", "mod+n"],
      ["Chat: new (alternate)", "mod+shift+o"],
    ]);
    expect(
      rows.filter((row) => row.command === "composer.sendBackground").map((row) => row.key),
    ).toEqual(["mod+enter", "mod+alt+enter"]);
  });

  it("lists rows in the order of the labels people read", () => {
    const labels = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "").map((row) =>
      commandLabel(row.command),
    );
    expect(labels).toEqual(labels.toSorted((left, right) => left.localeCompare(right)));
  });

  it("summarizes when clauses in plain words, falling back to the expression", () => {
    const summarize = (expression: string) => {
      const parsed = parseWhenExpressionDraft(expression);
      if (!parsed.ok) throw new Error(parsed.message);
      return whenSummary(parsed.value);
    };
    expect(summarize("")).toBe("Always");
    expect(summarize("!terminalFocus")).toBe("Outside terminal");
    expect(summarize("!terminalFocus && !modelPickerOpen")).toBe(
      "Outside terminal, model picker closed",
    );
    expect(summarize("previewFocus || composerFocus")).toBe("In preview or in composer");
    expect(summarize("!(terminalFocus && previewFocus)")).toBeNull();
    expect(summarize("terminalFocus && (previewFocus || composerFocus)")).toBeNull();
    expect(summarize("someRuntimeFlag")).toBeNull();
  });

  it("labels keycaps per platform", () => {
    expect(keycapLabel("mod", "MacIntel")).toBe("⌘");
    expect(keycapLabel("mod", "Win32")).toBe("Ctrl");
    expect(keycapLabel("arrowup", "MacIntel")).toBe("↑");
    expect(keycapLabel("enter", "MacIntel")).toBe("↩");
    expect(keycapLabel("enter", "Win32")).toBe("Enter");
    expect(keycapLabel("k", "Win32")).toBe("K");
    expect(keycapLabel("f5", "MacIntel")).toBe("F5");
  });

  it("builds known when variable options from defaults without frontend labels", () => {
    const options = buildWhenVariableOptions();

    expect(options).toEqual(
      expect.arrayContaining([
        "terminalFocus",
        "isWeb",
        "isDesktop",
        "modelPickerOpen",
        "true",
        "false",
      ]),
    );
    expect(options).not.toContain("customModeActive");
    expect(options).not.toContain("terminalOpen");
  });

  it("builds command options from all static commands and resolved project bindings", () => {
    const options = buildKeybindingCommandOptions([
      {
        command: "script.setup-db.run",
        shortcut: {
          key: "r",
          modKey: true,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
      },
    ] satisfies ResolvedKeybindingsConfig);

    expect(options).toEqual(
      expect.arrayContaining([
        "chat.new",
        "threadPanel.toggle",
        "rightPanel.toggleMaximized",
        "composer.cycleHost",
        "thread.stop",
        "usage.open",
        "script.setup-db.run",
      ]),
    );
    for (const command of ["thread.stop", "composer.cycleHost"]) {
      expect(DEFAULT_RESOLVED_KEYBINDINGS.some((binding) => binding.command === command)).toBe(
        false,
      );
    }
  });

  it("reports unknown when variables without rejecting parseable expressions", () => {
    const parsed = parseWhenExpressionDraft("!terminalFocus && terminalFoc");

    expect(parsed.ok).toBe(true);
    expect(unknownWhenVariables(parsed.ok ? parsed.value : undefined)).toEqual(["terminalFoc"]);
  });

  it("marks each default shortcut for multi-binding commands as default", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "chat.new",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
        {
          command: "chat.new",
          shortcut: {
            key: "o",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: true,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );

    expect(rows.map((row) => row.source)).toEqual(["Default", "Default"]);
  });

  it("reports conflicting shortcuts that share an active when context", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "chat.new",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
        {
          command: "chat.newLocal",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );

    expect(rows[0]?.conflicts).toEqual(["Chat: new local"]);
    expect(
      keybindingConflictLabels(rows, {
        rowId: rows[0]?.id ?? "",
        key: "mod+n",
        when: "",
      }),
    ).toEqual(["Chat: new local"]);
  });
});
