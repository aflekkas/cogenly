import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_DICTATION_CLIP_WIDTH_PX as CLIP,
  resolveComposerDictationFit,
  resolveRestingComposerControlsLayout,
  resolveRestingComposerControlsMinimumWidth,
} from "./composerFooterLayout";

// Picker 120px (52px at its minimum), mode 70px, traits 90px, overflow trigger 32px, 4px gaps.
const controls = {
  gap: 4,
  naturalFixedWidth: 120,
  minimumFixedWidth: 52,
  blockWidths: [70, 90],
  overflowWidth: 32,
};
// All blocks in overflow at the picker's minimum: 52 + 32 + 4.
const MINIMUM = 88;

describe("resolveRestingComposerControlsMinimumWidth", () => {
  it("folds every block into overflow at the picker's minimum width", () => {
    expect(resolveRestingComposerControlsMinimumWidth(controls)).toBe(MINIMUM);
  });
});

describe("resolveComposerDictationFit", () => {
  it("reserves the full waveform before it grows, so the controls fold first", () => {
    const hostWidth = 300;
    const fit = resolveComposerDictationFit({
      controls,
      hostWidth,
      renderedClipWidth: CLIP.idle,
      recording: true,
    });
    expect(fit.waveform).toBe("full");
    expect(fit.hostWidth).toBe(hostWidth - (CLIP.full - CLIP.idle));
    // Without the reservation both blocks would still show and then clip.
    expect(resolveRestingComposerControlsLayout({ ...controls, hostWidth }).hiddenCount).toBe(0);
    expect(
      resolveRestingComposerControlsLayout({ ...controls, hostWidth: fit.hostWidth }).hiddenCount,
    ).toBe(1);
  });

  it("drops to the newest bars only when even folded controls would not fit", () => {
    const fullNeeds = MINIMUM + CLIP.full - CLIP.idle;
    const fits = resolveComposerDictationFit({
      controls,
      hostWidth: fullNeeds,
      renderedClipWidth: CLIP.idle,
      recording: true,
    });
    expect(fits.waveform).toBe("full");
    const tight = resolveComposerDictationFit({
      controls,
      hostWidth: fullNeeds - 1,
      renderedClipWidth: CLIP.idle,
      recording: true,
    });
    expect(tight.waveform).toBe("compact");
    expect(tight.hostWidth).toBe(fullNeeds - 1 - (CLIP.compact - CLIP.idle));
    expect(
      resolveRestingComposerControlsLayout({ ...controls, hostWidth: tight.hostWidth }).visible,
    ).toBe(true);
  });

  it("keeps the same waveform size whichever size is currently drawn", () => {
    // The host narrows by exactly what the clip grows, as in the footer row.
    const rowWidth = MINIMUM + 30;
    for (const recording of [false, true]) {
      const sizes = Object.values(CLIP).map(
        (clip) =>
          resolveComposerDictationFit({
            controls,
            hostWidth: rowWidth - clip,
            renderedClipWidth: clip,
            recording,
          }).waveform,
      );
      expect(new Set(sizes).size).toBe(1);
    }
  });

  it("returns room only once the waveform has shrunk", () => {
    const hostWidth = 260;
    const stopping = resolveComposerDictationFit({
      controls,
      hostWidth,
      renderedClipWidth: CLIP.full,
      recording: false,
    });
    expect(stopping.hostWidth).toBe(hostWidth);
  });
});
