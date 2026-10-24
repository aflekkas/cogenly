#!/usr/bin/env node

// Renders the macOS Dock icon for each non-orange accent (Settings →
// Appearance → Accent color) into apps/desktop/resources/dock-icons, where
// DesktopDockIcon.ts picks it up. Each variant is the Cogenly mark
// (generate-cogenly-mark.ts) with its ember tones recolored by the CSS `color`
// blend (colorBlend in packages/shared/src/accentColors.ts): the accent's hue
// and saturation at the ember's lightness, as the composer's send tile and the
// boot splash do. The white rim and "c:" glyph stay white. The accent is its
// dark-theme base, the vivid one the default theme shows.
//
// Same canvas as the macOS app icon (render-cogenly-mark.ts): 1024px with the
// pre-Tahoe 100px safe area, so the tile matches the bundle icon's size.
// Rasterizes with headless Chromium through the server's playwright-core;
// pass `--chromium <path>` to pick the binary.

import * as NodeModule from "node:module";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ACCENT_PRESETS, colorBlend, hexToRgb } from "@t3tools/shared/accentColors";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/cli";

import { cogenlyMark } from "./generate-cogenly-mark.ts";

const OUTPUT_DIRECTORY = "apps/desktop/resources/dock-icons";
const MAC_CANVAS = 1024;
const MAC_INSET = 100;

// Only the slice of playwright-core this script drives.
interface MarkPage {
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  setContent(html: string): Promise<void>;
  screenshot(options: {
    omitBackground: boolean;
    clip: { x: number; y: number; width: number; height: number };
  }): Promise<Buffer>;
}
interface MarkBrowser {
  newPage(): Promise<MarkPage>;
  close(): Promise<void>;
}
interface Chromium {
  launch(options: { executablePath?: string }): Promise<MarkBrowser>;
}

// Every accent but orange, which keeps the bundle icon.
const tintedAccents = Object.entries(ACCENT_PRESETS);

export const renderAccentDockIcons = Effect.fn("renderAccentDockIcons")(function* (
  executablePath: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));

  // playwright-core is a server dependency; borrow it rather than adding a root one.
  const { chromium } = NodeModule.createRequire(path.join(repoRoot, "apps/server/package.json"))(
    "playwright-core",
  ) as { chromium: Chromium };

  const browser = yield* Effect.acquireRelease(
    Effect.promise(() => chromium.launch(executablePath ? { executablePath } : {})),
    (browser) => Effect.promise(() => browser.close()),
  );
  const page = yield* Effect.promise(() => browser.newPage());
  const body = MAC_CANVAS - MAC_INSET * 2;
  const render = (svg: string) =>
    Effect.promise(async () => {
      await page.setViewportSize({ width: MAC_CANVAS, height: MAC_CANVAS });
      await page.setContent(
        `<body style="margin:0;background:transparent"><div style="padding:${MAC_INSET}px;line-height:0">${svg.replace(
          'width="128" height="128"',
          `width="${body}" height="${body}"`,
        )}</div></body>`,
      );
      return page.screenshot({
        omitBackground: true,
        clip: { x: 0, y: 0, width: MAC_CANVAS, height: MAC_CANVAS },
      });
    });

  const outputDirectory = path.join(repoRoot, OUTPUT_DIRECTORY);
  yield* fs.makeDirectory(outputDirectory, { recursive: true });
  yield* Effect.forEach(tintedAccents, ([accent, preset]) =>
    Effect.gen(function* () {
      const tint = hexToRgb(preset.dark);
      const png = yield* render(cogenlyMark((tone) => colorBlend(tone, tint)));
      yield* fs.writeFile(path.join(outputDirectory, `${accent}.png`), png);
    }),
  );
  yield* Console.log(
    `Rendered ${tintedAccents.length} accent Dock icons into ${OUTPUT_DIRECTORY}.`,
  );
}, Effect.scoped);

export const renderAccentDockIconsCommand = Command.make(
  "render-accent-dock-icons",
  {
    chromium: Flag.String("chromium").pipe(
      Flag.withDescription("Chrome or headless-shell binary; defaults to Playwright's own."),
      Flag.optional,
    ),
  },
  ({ chromium }) => renderAccentDockIcons(Option.getOrUndefined(chromium)),
).pipe(Command.withDescription("Render the accent-tinted macOS Dock icons."));

if (import.meta.main) {
  Command.run(renderAccentDockIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
