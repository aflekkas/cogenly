import { describe, expect, it } from "vite-plus/test";

import { getPreviewPanelMaxWidth } from "./usePreviewPanelInlineSize";

describe("getPreviewPanelMaxWidth", () => {
  it("grows until the chat column beside it is down to 320px", () => {
    expect(getPreviewPanelMaxWidth(1440, 1392)).toBe(1072);
    expect(getPreviewPanelMaxWidth(2560, 2512)).toBe(2192);
  });

  it("never drops under the panel's own minimum when the row is too narrow for both", () => {
    expect(getPreviewPanelMaxWidth(800, 600)).toBe(360);
  });

  it("caps at a share of the viewport until the row is measured", () => {
    expect(getPreviewPanelMaxWidth(1280)).toBe(896);
  });
});
