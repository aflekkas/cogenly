# Brand icons

## Cogenly mark (current)

Every tracked icon is rendered from `brand/cogenly-mark.svg`: a rounded tile of ember pixels with a white lowercase "c" and a dot in its mouth. The tile's fill is a coarse grid (16 cells across) ordered-dithered with a 4x4 Bayer matrix between three quantized ember tones, from #FF7B3A at the top to #E63E22 at the bottom; the rounded silhouette clips the grid and stays smooth. Sizes up to 32px (16/32px favicons and the small ICO entries) use `brand/cogenly-mark-small.svg`, a heavier cut with a larger dot and an 8-cell grid so the pixels stay visible. Both masters are written by `node scripts/generate-cogenly-mark.ts`; edit that script rather than the SVGs. Both tiles, and every inline copy, use `rx="28"` on the 128 viewBox (a 21.875% circular corner); the DMG backgrounds embed that same small cut. `brand/cogenly-glyph.svg` is the bare "c" and dot. All three channels currently share the same artwork.

Run `vp run icons:mark` from the repository root to re-render the web favicons, apple-touch icons, Linux/universal PNGs, Windows ICOs, and macOS PNGs (with the 100px pre-Tahoe safe area) for all three channels, plus the `apps/web/public` copies. It rasterizes with headless Chromium through the server's `playwright-core`; pass `--chromium <path>` to pick the binary. The desktop build turns the macOS PNG into `icon.icns` with `iconutil`, so no `.icns` is tracked.

The Icon Composer projects below still carry the old T3 artwork, so `icons:export` and `icons:check` do not describe the shipped icons. Replace or redesign those projects before using that pipeline again.

## Icon Composer pipeline

The three Icon Composer projects are the source of truth for full application icons:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Each project uses `text.svg` for the foreground mark and `background.svg` when the background is a vector layer. Additional layers use semantic names that describe their role and placement.

Run `vp run icons:export` from the repository root to regenerate the tracked Linux, Windows, and web assets. The development web exports are also copied to `apps/web/public` for the browser favicon and splash screen. Run `vp run icons:check` to verify that the generated assets and public copies match their sources without changing files.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS exports

Icon Composer's command-line exporter does not expose the `macOS pre-Tahoe` preset. A plain command-line `macOS` export is full bleed and is not suitable for the desktop app, so the export script intentionally leaves the tracked macOS PNGs unchanged and prints a reminder after every run.

After changing an Icon Composer project, open it in Icon Composer and export the macOS PNG with exactly these settings:

- Platform: `macOS pre-Tahoe`
- Appearance: `Default`
- Size: `1024pt`
- Scale: `1×`

Save the three exports to:

- `dev/app-icon.icon` -> `dev/blueprint-macos-1024.png`
- `nightly/app-icon.icon` -> `nightly/nightly-macos-1024.png`
- `prod/app-icon.icon` -> `prod/black-macos-1024.png`

The result must be a 1024×1024 PNG with the classic macOS safe area: the opaque icon body is 824×824, inset 100 pixels on every side, with only the native Icon Composer shadow extending into the surrounding transparent canvas.

To have Codex perform the native exports, paste this prompt into a task opened at the repository root:

```text
Use [@Computer](plugin://computer-use@openai-bundled) and the Icon Composer app to export the three macOS app icons in this repository.

For each project below, use Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, and Scale: 1×, then save the PNG to the exact destination:

- assets/dev/app-icon.icon -> assets/dev/blueprint-macos-1024.png
- assets/nightly/app-icon.icon -> assets/nightly/nightly-macos-1024.png
- assets/prod/app-icon.icon -> assets/prod/black-macos-1024.png

Do not resize, composite, or otherwise post-process the exported PNGs.

Verify every result is 1024×1024 and has the classic macOS safe area: an 824×824 opaque body inset 100px on every side, with only Icon Composer's native shadow extending beyond it.
```

Do not edit the generated PNG or ICO files directly.
