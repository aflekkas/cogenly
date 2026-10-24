import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { describe, expect, it } from "vite-plus/test";

import { describeCopiedToast, plainToastLabel } from "./copiedToast.logic";

describe("describeCopiedToast", () => {
  it("names a copied thread link by its title, without markdown or the URL", () => {
    const link = formatThreadLink(
      "3d433d18-ebd1-4d43-b78b-805c67a8333b",
      "What Makes Humans Special in Star Wars fork",
    );
    expect(describeCopiedToast({ kind: "thread-link", link })).toEqual({
      title: "Link copied",
      label: "What Makes Humans Special in Star Wars fork",
      icon: "thread",
    });
  });

  it("labels a thread ID copy with the thread title when known", () => {
    expect(
      describeCopiedToast({ kind: "thread-id", threadId: "abc-123", threadTitle: "Fix login" }),
    ).toMatchObject({ title: "Thread ID copied", label: "Fix login" });
  });

  it("shows a path's folder name and a branch's name", () => {
    expect(describeCopiedToast({ kind: "path", path: "/Users/me/code/cogenly/" })).toMatchObject({
      title: "Path copied",
      label: "cogenly",
      icon: "folder",
    });
    expect(describeCopiedToast({ kind: "branch", branch: "feat/toasts" })).toMatchObject({
      title: "Branch copied",
      label: "feat/toasts",
    });
  });
});

describe("plainToastLabel", () => {
  it("drops bare URLs and keeps link text", () => {
    expect(plainToastLabel("See [the docs](https://example.com/x) at https://a.b/c")).toBe(
      "See the docs at",
    );
  });

  it("keeps ordinary punctuation in titles", () => {
    expect(plainToastLabel("Fix (login) bug: part 2")).toBe("Fix (login) bug: part 2");
  });

  it("is null when nothing readable is left", () => {
    expect(plainToastLabel("cogenly-thread://v1/abc")).toBeNull();
    expect(plainToastLabel("   ")).toBeNull();
    expect(plainToastLabel(undefined)).toBeNull();
  });

  it("shortens very long labels with an ellipsis", () => {
    const label = plainToastLabel("x".repeat(200));
    expect(label).toHaveLength(80);
    expect(label?.endsWith("…")).toBe(true);
  });
});
