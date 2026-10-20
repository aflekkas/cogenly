import { describe, expect, it } from "vite-plus/test";

import {
  formatThreadLink,
  parseAppThreadUrl,
  parseThreadLinkHref,
  relabelThreadLinks,
} from "./threadLinks.ts";

describe("thread links", () => {
  it("takes the thread id verbatim, percent escapes included", () => {
    expect(parseThreadLinkHref("cogenly-thread://v1/mcp:1234")).toBe("mcp:1234");
    expect(parseThreadLinkHref("cogenly-thread://v1/thread:delegated-task:mcp%3A1")).toBe(
      "thread:delegated-task:mcp%3A1",
    );
  });

  it("still reads the legacy t3-thread scheme", () => {
    expect(parseThreadLinkHref("t3-thread://v1/5609dcde-b1fa")).toBe("5609dcde-b1fa");
    expect(relabelThreadLinks("[Old](t3-thread://v1/t1)", () => "New")).toBe(
      "[New](cogenly-thread://v1/t1)",
    );
  });

  it("rejects other links and an empty id", () => {
    expect(parseThreadLinkHref("https://t3.codes")).toBeNull();
    expect(parseThreadLinkHref("cogenly-thread://v1/")).toBeNull();
    expect(parseThreadLinkHref("cogenly-thread://v1/ ")).toBeNull();
  });

  it("resolves a percent-encoded id when the id as written names no thread", () => {
    const titles = new Map([
      ["thread:project:1", "Decoded"],
      ["provider%3A1", "Literal escape"],
    ]);
    expect(
      relabelThreadLinks(
        "[a](cogenly-thread://v1/thread%3Aproject%3A1) [b](cogenly-thread://v1/provider%3A1)",
        (threadId) => titles.get(threadId),
      ),
    ).toBe(
      "[Decoded](cogenly-thread://v1/thread:project:1) [Literal escape](cogenly-thread://v1/provider%3A1)",
    );
    // A thread with an empty title still exists, so its link is not redirected.
    const untitled = new Map([
      ["a%3A1", ""],
      ["a:1", "Other"],
    ]);
    expect(
      relabelThreadLinks("[Kept](cogenly-thread://v1/a%3A1)", (threadId) => untitled.get(threadId)),
    ).toBe("[Kept](cogenly-thread://v1/a%3A1)");
  });

  it("leaves links inside code spans and fences as written", () => {
    const markdown = [
      "Live [old](cogenly-thread://v1/t1), literal `[old](cogenly-thread://v1/t1)`.",
      "```md",
      "[old](cogenly-thread://v1/t1)",
      "```",
      "After [old](cogenly-thread://v1/t1)",
    ].join("\n");
    expect(relabelThreadLinks(markdown, () => "New")).toBe(
      [
        "Live [New](cogenly-thread://v1/t1), literal `[old](cogenly-thread://v1/t1)`.",
        "```md",
        "[old](cogenly-thread://v1/t1)",
        "```",
        "After [New](cogenly-thread://v1/t1)",
      ].join("\n"),
    );
  });

  it("formats a label that would otherwise break the Markdown link", () => {
    expect(formatThreadLink("t1", "Fix [ci] \\ build")).toBe(
      "[Fix ci build](cogenly-thread://v1/t1)",
    );
    expect(formatThreadLink("t1", " ] ")).toBe("[t1](cogenly-thread://v1/t1)");
  });

  it("relabels links with the current title and leaves unknown threads alone", () => {
    const titles = new Map([["renamed", "Fix [the] build\nnow"]]);
    expect(
      relabelThreadLinks(
        "See [Old name](cogenly-thread://v1/renamed) and [Gone](cogenly-thread://v1/deleted).",
        (threadId) => titles.get(threadId),
      ),
    ).toBe(
      "See [Fix the build now](cogenly-thread://v1/renamed) and [Gone](cogenly-thread://v1/deleted).",
    );
  });

  describe("app thread URLs", () => {
    const current = "http://localhost:9734/env-1/current";

    it("reads a thread page on the current origin or a loopback dev server", () => {
      expect(parseAppThreadUrl("http://localhost:9734/env-1/thread-1", current)).toEqual({
        environmentId: "env-1",
        threadId: "thread-1",
      });
      expect(parseAppThreadUrl("http://127.0.0.1:5733/env-1/thread%3A1?x=1#y", null)).toEqual({
        environmentId: "env-1",
        threadId: "thread:1",
      });
      expect(
        parseAppThreadUrl("https://box.tail.ts.net/env-1/thread-1", "https://box.tail.ts.net/"),
      ).toEqual({ environmentId: "env-1", threadId: "thread-1" });
      expect(parseAppThreadUrl("cogenly://app/env-1/thread-1", "cogenly://app/env-1/t")).toEqual({
        environmentId: "env-1",
        threadId: "thread-1",
      });
    });

    it("ignores other sites, other routes, and other path shapes", () => {
      expect(parseAppThreadUrl("https://github.com/owner/repo", current)).toBeNull();
      expect(parseAppThreadUrl("http://localhost:9734/settings/general", current)).toBeNull();
      expect(parseAppThreadUrl("http://localhost:9734/draft/abc", current)).toBeNull();
      expect(parseAppThreadUrl("http://localhost:9734/env-1", current)).toBeNull();
      expect(parseAppThreadUrl("http://localhost:9734/a/b/c", current)).toBeNull();
      expect(parseAppThreadUrl("not a url", current)).toBeNull();
    });
  });
});
