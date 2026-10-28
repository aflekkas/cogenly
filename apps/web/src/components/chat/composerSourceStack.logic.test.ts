import type { IntegrationSource, LinkContextRecord, ThreadSource } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composerSourceStackWindow, deriveComposerSourcesInUse } from "./composerSourceStack.logic";

const source = (name: string) =>
  ({ id: `int-${name}`, name, displayName: name }) as unknown as IntegrationSource;
const all = [source("gmail"), source("linear"), source("wispr"), source("slack")];

const mention = (name: string) =>
  ({ kind: "integration", integrationId: `int-${name}`, name }) as unknown as LinkContextRecord;
const used = (name: string, usedAt: string) =>
  ({ kind: "integration", key: `integration:${name}`, name, usedAt, uses: 1 }) as ThreadSource;

describe("deriveComposerSourcesInUse", () => {
  it("puts the draft's newest mention first, then what the thread used, once each", () => {
    const inUse = deriveComposerSourcesInUse({
      draftContexts: [mention("linear"), mention("wispr")],
      threadSources: [used("gmail", "2026-10-26T11:00:00Z"), used("linear", "2026-10-26T10:00:00Z")],
      removed: [],
      all,
    });
    expect(inUse.map((entry) => entry.name)).toEqual(["wispr", "linear", "gmail"]);
  });

  it("keeps a removed source out until the draft mentions it again", () => {
    const threadSources = [used("gmail", "2026-10-26T11:00:00Z")];
    expect(
      deriveComposerSourcesInUse({ draftContexts: [], threadSources, removed: ["gmail"], all }),
    ).toEqual([]);
    expect(
      deriveComposerSourcesInUse({
        draftContexts: [mention("gmail")],
        threadSources,
        removed: ["gmail"],
        all,
      }).map((entry) => entry.name),
    ).toEqual(["gmail"]);
  });

  it("skips sources the environment no longer has and non-integration sources", () => {
    const inUse = deriveComposerSourcesInUse({
      draftContexts: [],
      threadSources: [
        used("gone", "2026-10-26T11:00:00Z"),
        { kind: "memory", key: "memory", usedAt: "2026-10-26T11:00:00Z", uses: 1 },
      ],
      removed: [],
      all,
    });
    expect(inUse).toEqual([]);
  });
});

describe("composerSourceStackWindow", () => {
  it("shows up to four icons and folds the rest into a count", () => {
    expect(composerSourceStackWindow([1, 2, 3])).toEqual({ shown: [1, 2, 3], overflow: 0 });
    expect(composerSourceStackWindow([1, 2, 3, 4, 5, 6])).toEqual({
      shown: [1, 2, 3, 4],
      overflow: 2,
    });
  });
});
