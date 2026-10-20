import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { findVisualRowIndex, submittedVisualRenderId } from "./visualSubmitChip.logic";

const visual = (renderId: string, title: string, submittedAt: string | null) => ({
  renderId,
  title,
  submittedAt: submittedAt === null ? null : DateTime.makeUnsafe(submittedAt),
});

const renderRow = (attachmentId: string, title: string) => ({
  kind: "html-render",
  id: `row-${attachmentId}`,
  htmlRender: { attachmentId, title, height: 400 },
});

describe("submittedVisualRenderId", () => {
  const states = [
    visual("quiz-a", "Quiz", "2026-10-20T10:00:00.000Z"),
    visual("quiz-b", "Quiz", "2026-10-20T11:00:00.000Z"),
    visual("draft", "Quiz", null),
    visual("review", "Review", "2026-10-20T10:30:00.000Z"),
  ];

  it("picks the same-titled visual submitted closest to the turn", () => {
    expect(submittedVisualRenderId(states, "Quiz", "2026-10-20T10:00:00.050Z")).toBe("quiz-a");
    expect(submittedVisualRenderId(states, "Quiz", "2026-10-20T11:00:01.000Z")).toBe("quiz-b");
    expect(submittedVisualRenderId(states, "Review", "2026-10-20T11:00:00.000Z")).toBe("review");
  });

  it("finds nothing for a title no submitted visual has", () => {
    expect(submittedVisualRenderId(states, "Other", "2026-10-20T10:00:00.000Z")).toBeNull();
    expect(
      submittedVisualRenderId([visual("draft", "Quiz", null)], "Quiz", "2026-10-20T10:00:00Z"),
    ).toBeNull();
  });
});

describe("findVisualRowIndex", () => {
  const rows = [
    { kind: "message", id: "m1" },
    renderRow("quiz-a", "Quiz"),
    { kind: "message", id: "m2" },
    renderRow("quiz-b", "Quiz"),
  ];

  it("finds the render by id, else the latest render with the title", () => {
    expect(findVisualRowIndex(rows, "quiz-a", "Quiz")).toBe(1);
    expect(findVisualRowIndex(rows, null, "Quiz")).toBe(3);
    expect(findVisualRowIndex(rows, "unloaded", "Quiz")).toBe(3);
  });

  it("reports a visual outside the loaded timeline", () => {
    expect(findVisualRowIndex(rows, "unloaded", null)).toBe(-1);
    expect(findVisualRowIndex(rows, null, "Other")).toBe(-1);
  });
});
