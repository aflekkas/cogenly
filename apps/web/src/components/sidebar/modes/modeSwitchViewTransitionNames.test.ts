// @effect-diagnostics nodeBuiltinImport:off - reads the stylesheet and component sources under test.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const srcDir = new URL("../../../", import.meta.url);
const MOBILE_SCOPE = 'html[data-mobile-composer-route-transition="true"]';

function sourceFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * A mode switch is one crossfade of the root (modeSwitchMotion.ts). Any element
 * that carries a view-transition-name while it runs is lifted out of that
 * crossfade into its own layer above it, so the outgoing screen's piece of UI
 * (the Work draft's composer and workspace bar, say) paints on top of the
 * incoming screen. Names may only exist inside the mobile composer transition.
 */
describe("view-transition names", () => {
  const files = sourceFiles(srcDir.pathname);

  it("are never set inline from a component", () => {
    const offenders = files.filter(
      (file) =>
        !file.endsWith(".css") && /viewTransitionName/.test(NodeFS.readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("are only declared under the mobile composer transition", () => {
    const offenders: string[] = [];
    for (const file of files.filter((path) => path.endsWith(".css"))) {
      const css = NodeFS.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of css.matchAll(/([^{}]*)\{[^{}]*view-transition-name\s*:\s*([^;}]+)/g)) {
        const selector = match[1]!.trim();
        if (match[2]!.trim() === "none") continue;
        if (!selector.startsWith(MOBILE_SCOPE)) offenders.push(`${file}: ${selector}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
