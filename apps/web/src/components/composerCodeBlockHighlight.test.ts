import { Editor } from "@tiptap/core";
import { EditorState, type Plugin, type Transaction } from "@tiptap/pm/state";
import type { DecorationSet, EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { ComposerCodeBlockExtension } from "~/composer-rich-text-doc";
import type { DiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

import { composerCodeBlockHighlight, tokenizeBlock } from "./composerCodeBlockHighlight";

vi.mock("~/lib/syntaxHighlighting", () => ({ getSyntaxHighlighterPromise: vi.fn() }));

const THEME: DiffThemeName = "pierre-dark";

function fakeHighlighter(colorFor: (content: string) => string | undefined) {
  return {
    codeToTokens(code: string) {
      return {
        tokens: code.split(/\r?\n/).map((line) =>
          line
            .split(/(\s+)/)
            .filter((part) => part.length > 0)
            .map((content) => ({ content, color: colorFor(content) })),
        ),
      };
    },
  } as unknown as Parameters<typeof tokenizeBlock>[0];
}

describe("highlighting edited fences", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function mountFence(text: string, resolveTheme = () => THEME) {
    vi.useFakeTimers();
    const highlighter = fakeHighlighter((content) =>
      content.startsWith("x") ? "#ff0000" : undefined,
    );
    const tokenize = vi.spyOn(highlighter, "codeToTokens");
    vi.mocked(getSyntaxHighlighterPromise).mockResolvedValue(highlighter);
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ codeBlock: false, trailingNode: false }),
        ComposerCodeBlockExtension,
        composerCodeBlockHighlight({ resolveTheme }),
      ],
      content: {
        type: "doc",
        content: [
          { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text }] },
        ],
      },
    });
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const plugin = editor.extensionManager.plugins.find((candidate) =>
      (candidate as unknown as { key: string }).key.startsWith("composerCodeBlockHighlight"),
    ) as Plugin<DecorationSet>;
    // A headless editor holds no plugins in its state, so give this one its own.
    let state = EditorState.create({ doc: editor.state.doc, plugins: [plugin] });
    // Like a real view, every dispatch updates the plugin's view.
    let pluginView: ReturnType<NonNullable<typeof plugin.spec.view>> | undefined;
    const view = {
      get state() {
        return state;
      },
      dispatch: (transaction: Transaction) => {
        const previous = state;
        state = state.apply(transaction);
        pluginView?.update?.(view, previous);
      },
    } as unknown as EditorView;
    pluginView = plugin.spec.view!(view);
    onTestFinished(() => {
      pluginView?.destroy?.();
      editor.destroy();
    });
    await vi.advanceTimersByTimeAsync(0);
    return {
      tokenize,
      ranges: () =>
        plugin
          .getState(state)!
          .find()
          .map(({ from, to }) => [from, to]),
      edit: async (change: (transaction: Transaction) => Transaction) => {
        view.dispatch(change(state.tr));
        await vi.advanceTimersByTimeAsync(0);
      },
      colored: () =>
        plugin
          .getState(state)!
          .find()
          .map((decoration) => state.doc.textBetween(decoration.from, decoration.to)),
    };
  }

  it("maps colors while typing above 2,000 characters and refreshes 300 ms after the last edit", async () => {
    const fence = await mountFence(`x ${"y".repeat(1_999)}`);
    expect(fence.tokenize).toHaveBeenCalledTimes(1);

    await fence.edit((tr) => tr.insertText("x ", 1));
    await vi.advanceTimersByTimeAsync(250);
    await fence.edit((tr) => tr.insertText("y ", 1));
    await vi.advanceTimersByTimeAsync(299);

    expect(fence.tokenize).toHaveBeenCalledTimes(1);
    expect(fence.colored()).toEqual(["x"]);
    expect(fence.ranges()).toEqual([[5, 6]]);

    await vi.advanceTimersByTimeAsync(1);

    expect(fence.tokenize).toHaveBeenCalledTimes(2);
    expect(fence.colored()).toEqual(["x", "x"]);
  });

  it("ignores a pending highlight when its text is edited away and restored", async () => {
    const fence = await mountFence(`x ${"y".repeat(1_999)}`);
    const staleHighlighter = fakeHighlighter(() => "#00ff00");
    const staleTokenize = vi.spyOn(staleHighlighter, "codeToTokens");
    let finishLoading!: () => void;
    vi.mocked(getSyntaxHighlighterPromise).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoading = () => resolve(staleHighlighter);
        }),
    );

    await fence.edit((tr) => tr.insertText("x ", 1));
    await vi.advanceTimersByTimeAsync(300);
    await fence.edit((tr) => tr.insertText("y ", 1));
    await fence.edit((tr) => tr.delete(1, 3));
    finishLoading();
    await vi.advanceTimersByTimeAsync(0);

    expect(staleTokenize).not.toHaveBeenCalled();
    expect(fence.colored()).toEqual(["x"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(fence.tokenize).toHaveBeenCalledTimes(2);
    expect(fence.colored()).toEqual(["x", "x"]);
  });

  it("refreshes a long fence immediately when the theme changes during a pending edit", async () => {
    let theme: DiffThemeName = THEME;
    const fence = await mountFence(`x ${"y".repeat(1_999)}`, () => theme);
    await fence.edit((tr) => tr.insertText("x ", 1));

    theme = "pierre-light";
    await fence.edit((tr) => tr.setMeta("theme", true));

    expect(fence.tokenize).toHaveBeenCalledTimes(2);
    expect(fence.tokenize).toHaveBeenLastCalledWith(expect.any(String), { lang: "ts", theme });
    expect(fence.colored()).toEqual(["x", "x"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(fence.tokenize).toHaveBeenCalledTimes(2);
  });

  it("refreshes immediately when an edit leaves the fence at 2,000 characters", async () => {
    const fence = await mountFence(`x ${"y".repeat(1_996)}`);

    await fence.edit((tr) => tr.insertText("x ", 1));

    expect(fence.tokenize).toHaveBeenCalledTimes(2);
    expect(fence.colored()).toEqual(["x", "x"]);
  });

  it("clips a split token to its fences without coloring the paragraph between them", async () => {
    const fence = await mountFence("x".repeat(6_000));

    await fence.edit((tr) =>
      tr
        .split(3_001)
        .insert(
          3_002,
          tr.doc.type.schema.node("paragraph", null, [tr.doc.type.schema.text("plain")]),
        ),
    );

    expect(fence.tokenize).toHaveBeenCalledTimes(1);
    expect(fence.ranges()).toEqual([
      [1, 3_001],
      [3_010, 6_010],
    ]);
    expect(fence.colored()).toEqual(["x".repeat(3_000), "x".repeat(3_000)]);
  });

  it("clears retained colors when the new language highlighter fails to load", async () => {
    const fence = await mountFence(`x ${"y".repeat(1_999)}`);
    vi.mocked(getSyntaxHighlighterPromise).mockRejectedValue(new Error("Shiki failed to load"));

    await fence.edit((tr) => tr.setNodeMarkup(0, undefined, { language: "py" }));
    expect(fence.colored()).toEqual(["x"]);

    await vi.advanceTimersByTimeAsync(300);

    expect(fence.colored()).toEqual([]);
  });
});
