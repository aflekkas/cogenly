import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  anchoredEndSpaceSize,
  anchoredScrollTarget,
  resolveSendAnchorEndSpace,
  sendAnchorOffset,
} from "./timelineSendAnchor";

interface Row {
  readonly id: string;
  readonly userMessageId: MessageId | null;
}

const first = MessageId.make("first");
const latest = MessageId.make("latest");
const rows: ReadonlyArray<Row> = [
  { id: "a", userMessageId: first },
  { id: "b", userMessageId: null },
  { id: "c", userMessageId: latest },
  { id: "d", userMessageId: null },
];
const userMessageId = (row: Row) => row.userMessageId;

describe("sendAnchorOffset", () => {
  it("sits the sent message below the floating header, at a thread's first-row gap", () => {
    expect(sendAnchorOffset(52)).toBe(76);
    expect(sendAnchorOffset(0)).toBe(24);
    expect(sendAnchorOffset(-4)).toBe(24);
  });
});

describe("resolveSendAnchorEndSpace", () => {
  it("anchors a later turn's message, not only the thread's first", () => {
    expect(resolveSendAnchorEndSpace(rows, latest, userMessageId, 76)).toEqual({
      anchorIndex: 2,
      anchorOffset: 76,
    });
    expect(resolveSendAnchorEndSpace(rows, first, userMessageId, 76)).toEqual({
      anchorIndex: 0,
      anchorOffset: 76,
    });
  });

  it("reserves nothing without an anchor or before its row exists", () => {
    expect(resolveSendAnchorEndSpace(rows, null, userMessageId, 76)).toBeUndefined();
    expect(
      resolveSendAnchorEndSpace(rows, MessageId.make("missing"), userMessageId, 76),
    ).toBeUndefined();
  });
});

describe("anchoredEndSpaceSize", () => {
  it("fills the viewport under a short turn so the message can reach the top", () => {
    // 900px viewport, the sent message (60px) and no reply yet.
    expect(anchoredEndSpaceSize({ viewportHeight: 900, turnHeight: 60, anchorOffset: 76 })).toBe(
      764,
    );
  });

  it("shrinks one for one as the reply grows", () => {
    const short = anchoredEndSpaceSize({ viewportHeight: 900, turnHeight: 200, anchorOffset: 76 });
    const longer = anchoredEndSpaceSize({ viewportHeight: 900, turnHeight: 350, anchorOffset: 76 });
    expect(short - longer).toBe(150);
    // Turn plus space always spans the viewport below the anchor offset.
    expect(200 + short + 76).toBe(900);
  });

  it("is gone once the turn fills the viewport", () => {
    expect(anchoredEndSpaceSize({ viewportHeight: 900, turnHeight: 824, anchorOffset: 76 })).toBe(
      0,
    );
    expect(anchoredEndSpaceSize({ viewportHeight: 900, turnHeight: 2000, anchorOffset: 76 })).toBe(
      0,
    );
  });
});

describe("anchoredScrollTarget", () => {
  it("puts the anchored row its offset below the top", () => {
    expect(anchoredScrollTarget({ anchorTop: 1400, anchorOffset: 76, maxScroll: 2000 })).toBe(1324);
  });

  it("does not scroll a new chat's first message, which already sits there", () => {
    expect(anchoredScrollTarget({ anchorTop: 76, anchorOffset: 76, maxScroll: 52 })).toBe(0);
  });

  it("stays inside the scroll range", () => {
    expect(anchoredScrollTarget({ anchorTop: 1400, anchorOffset: 76, maxScroll: 1000 })).toBe(1000);
    expect(anchoredScrollTarget({ anchorTop: 20, anchorOffset: 76, maxScroll: 1000 })).toBe(0);
    expect(anchoredScrollTarget({ anchorTop: 400, anchorOffset: 76, maxScroll: -10 })).toBe(0);
  });

  it("reaches the target when the end space is installed", () => {
    // Rows above the turn: 1324px. The space makes the content exactly long
    // enough for the anchor to reach its offset.
    const viewportHeight = 900;
    const anchorTop = 1400;
    const turnHeight = 120;
    const space = anchoredEndSpaceSize({ viewportHeight, turnHeight, anchorOffset: 76 });
    const maxScroll = anchorTop + turnHeight + space - viewportHeight;
    expect(anchoredScrollTarget({ anchorTop, anchorOffset: 76, maxScroll })).toBe(anchorTop - 76);
  });
});
