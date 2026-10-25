import { describe, expect, it } from "vite-plus/test";

import { formatSettingValue } from "./settingValueLabels";

describe("formatSettingValue", () => {
  it("names an option by the label its control shows", () => {
    expect(formatSettingValue("responseStreamingMode", "paragraph")).toBe(
      "Show finished paragraphs",
    );
    expect(formatSettingValue("branchNamingMode", "semantic")).toBe("Semantic prefix");
  });

  it("keeps free-text values as written", () => {
    expect(formatSettingValue("branchNamePrefix", "constructor")).toBe("constructor");
    expect(formatSettingValue("branchNamePrefix", "")).toBe("Empty");
  });
});
