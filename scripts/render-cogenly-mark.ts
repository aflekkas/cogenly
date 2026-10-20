#!/usr/bin/env node

// Renders the Cogenly mark (assets/brand/cogenly-mark.svg) into every tracked
// web and desktop icon, keeping the existing file names so the desktop
// launcher, DesktopAssets, and apply-web-brand-assets need no changes.
// Sizes up to 32px use cogenly-mark-small.svg, a heavier cut that stays legible
// on the favicon pixel grid.
//
// This replaces `icons:export`: that pipeline needs Icon Composer, and its
// .icon projects still carry the old T3 artwork.

import * as NodeModule from "node:module";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/cli";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const MARK_SOURCE = "assets/brand/cogenly-mark.svg";
const SMALL_MARK_SOURCE = "assets/brand/cogenly-mark-small.svg";
const SMALL_MARK_MAX_SIZE = 32;
const PUBLIC_MARK = "apps/web/public/cogenly-mark.svg";

// The classic macOS safe area: an 824px body inset 100px on a 1024px canvas.
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

export const renderCogenlyMark = Effect.fn("renderCogenlyMark")(function* (
  executablePath: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const svg = yield* fs.readFileString(path.join(repoRoot, MARK_SOURCE));
  const smallSvg = yield* fs.readFileString(path.join(repoRoot, SMALL_MARK_SOURCE));

  // playwright-core is a server dependency; borrow it rather than adding a root one.
  const { chromium } = NodeModule.createRequire(path.join(repoRoot, "apps/server/package.json"))(
    "playwright-core",
  ) as { chromium: Chromium };

  const browser = yield* Effect.acquireRelease(
    Effect.promise(() => chromium.launch(executablePath ? { executablePath } : {})),
    (browser) => Effect.promise(() => browser.close()),
  );
  const page = yield* Effect.promise(() => browser.newPage());
  const render = (canvas: number, inset = 0) =>
    Effect.promise(async () => {
      const body = canvas - inset * 2;
      const source = body <= SMALL_MARK_MAX_SIZE ? smallSvg : svg;
      await page.setViewportSize({ width: canvas, height: canvas });
      await page.setContent(
        `<body style="margin:0;background:transparent"><div style="padding:${inset}px;line-height:0">${source.replace(
          'width="128" height="128"',
          `width="${body}" height="${body}"`,
        )}</div></body>`,
      );
      return page.screenshot({
        omitBackground: true,
        clip: { x: 0, y: 0, width: canvas, height: canvas },
      });
    });

  const ico = encodePngIco(
    yield* Effect.forEach(WINDOWS_ICON_SIZES, (size) =>
      render(size).pipe(Effect.map((contents) => ({ size, contents }))),
    ),
  );
  const universal = yield* render(1024);
  const mac = yield* render(MAC_CANVAS, MAC_INSET);
  const appleTouch = yield* render(180);
  const favicon16 = yield* render(16);
  const favicon32 = yield* render(32);

  const P = BRAND_ASSET_PATHS;
  const outputs: ReadonlyArray<readonly [string, Uint8Array]> = [
    [P.developmentDesktopIconPng, mac],
    [P.developmentUniversalIconPng, universal],
    [P.developmentWindowsIconIco, ico],
    [P.developmentWebFaviconIco, ico],
    [P.developmentWebFavicon16Png, favicon16],
    [P.developmentWebFavicon32Png, favicon32],
    [P.developmentWebAppleTouchIconPng, appleTouch],
    [P.nightlyMacIconPng, mac],
    [P.nightlyLinuxIconPng, universal],
    [P.nightlyWindowsIconIco, ico],
    [P.nightlyWebFaviconIco, ico],
    [P.nightlyWebFavicon16Png, favicon16],
    [P.nightlyWebFavicon32Png, favicon32],
    [P.nightlyWebAppleTouchIconPng, appleTouch],
    [P.productionMacIconPng, mac],
    [P.productionLinuxIconPng, universal],
    [P.productionWindowsIconIco, ico],
    [P.productionWebFaviconIco, ico],
    [P.productionWebFavicon16Png, favicon16],
    [P.productionWebFavicon32Png, favicon32],
    [P.productionWebAppleTouchIconPng, appleTouch],
  ];
  yield* Effect.forEach(outputs, ([relativePath, contents]) =>
    fs.writeFile(path.join(repoRoot, relativePath), contents),
  );
  // apps/web/public serves the development set to the dev server and splash.
  yield* Effect.forEach(DEVELOPMENT_PUBLIC_ICON_OVERRIDES, (override) =>
    fs.copyFile(
      path.join(repoRoot, override.sourceRelativePath),
      path.join(repoRoot, override.targetRelativePath),
    ),
  );
  yield* fs.writeFileString(path.join(repoRoot, PUBLIC_MARK), svg);
  yield* Console.log(
    `Rendered ${MARK_SOURCE} into ${outputs.length + DEVELOPMENT_PUBLIC_ICON_OVERRIDES.length + 1} files.`,
  );
}, Effect.scoped);

export const renderCogenlyMarkCommand = Command.make(
  "render-cogenly-mark",
  {
    chromium: Flag.String("chromium").pipe(
      Flag.withDescription("Chrome or headless-shell binary; defaults to Playwright's own."),
      Flag.optional,
    ),
  },
  ({ chromium }) => renderCogenlyMark(Option.getOrUndefined(chromium)),
).pipe(Command.withDescription("Render the Cogenly mark into every tracked icon."));

if (import.meta.main) {
  Command.run(renderCogenlyMarkCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
