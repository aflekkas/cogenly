// @effect-diagnostics nodeBuiltinImport:off - reads the settings sources whose anchors search lands on.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_SEARCH_ITEMS, type SettingsSearchItem } from "./settingsSearch";

const srcDir = new URL("../../", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
  });
}

/**
 * Every element id a component renders as a literal, or through
 * `searchableSetting`. Generated anchors (keybinding rows, source control
 * hosts) come from the same helper on both sides, so they are checked by prefix.
 */
function renderedAnchorIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const file of sourceFiles(srcDir)) {
    const source = NodeFS.readFileSync(file, "utf8");
    for (const match of source.matchAll(/searchableSetting\("([a-z0-9-]+)"\)/g)) ids.add(match[1]!);
    for (const match of source.matchAll(/\bid=(?:"([a-z0-9-]+)"|\{"([a-z0-9-]+)"\})/g)) {
      ids.add(match[1] ?? match[2]!);
    }
  }
  return ids;
}

const GENERATED_PREFIXES = ["keybinding-", "source-control-host-"];

describe("settings search anchors", () => {
  it("land on an element their page renders", () => {
    const rendered = renderedAnchorIds();
    const items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS;
    const missing = items
      .map((item) => item.targetId ?? item.id)
      .filter(
        (target) =>
          !rendered.has(target) && !GENERATED_PREFIXES.some((prefix) => target.startsWith(prefix)),
      );
    expect(missing).toEqual([]);
  });
});
