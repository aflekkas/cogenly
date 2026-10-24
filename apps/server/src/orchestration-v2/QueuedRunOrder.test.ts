import { describe, expect, it } from "vite-plus/test";

import {
  combineQueuedMessages,
  QUEUED_MESSAGE_SEPARATOR,
  queuedRunsInDeliveryOrder,
  userQueuedMessagesInDeliveryOrder,
} from "./QueuedRunOrder.ts";

describe("queued run delivery order", () => {
  it("keeps automatic completion delivery ahead of visible queued messages", () => {
    const projection = {
      messages: [
        { id: "message:visible-first" },
        {
          id: "message:automatic",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message:visible-second" },
      ],
      runs: [
        {
          id: "run:visible-first",
          ordinal: 2,
          queuePosition: 1,
          status: "queued",
          userMessageId: "message:visible-first",
        },
        {
          id: "run:automatic",
          ordinal: 4,
          queuePosition: 3,
          status: "queued",
          userMessageId: "message:automatic",
        },
        {
          id: "run:visible-second",
          ordinal: 3,
          queuePosition: 2,
          status: "queued",
          userMessageId: "message:visible-second",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:automatic",
      "run:visible-first",
      "run:visible-second",
    ]);
  });
});

describe("combining queued messages", () => {
  it("joins texts in order and keeps each attachment and context reference once", () => {
    const image = {
      type: "image",
      id: "image-1",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 1,
    } as const;
    const file = {
      type: "file",
      id: "file-1",
      name: "b.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
    } as const;
    const record = (contextId: string) => ({ contextId }) as never;
    const combined = combineQueuedMessages([
      { text: "First", attachments: [image], context: { version: 1, records: [record("a")] } },
      { text: "  ", attachments: [image, file] },
      { text: "Third", attachments: [], context: { version: 1, records: [record("a")] } },
    ]);
    expect(combined.text).toBe(["First", "Third"].join(QUEUED_MESSAGE_SEPARATOR));
    expect(combined.attachments.map((attachment) => attachment.id)).toEqual(["image-1", "file-1"]);
    expect(combined.context?.records).toHaveLength(1);
  });

  it("leaves automatic deliveries out of the user's queue", () => {
    const projection = {
      messages: [
        { id: "message:user" },
        { id: "message:notice", notification: {} },
        { id: "message:automatic", delegatedCompletion: {} },
      ],
      runs: [
        { id: "run:user", ordinal: 1, status: "queued", userMessageId: "message:user" },
        { id: "run:notice", ordinal: 2, status: "queued", userMessageId: "message:notice" },
        { id: "run:automatic", ordinal: 3, status: "queued", userMessageId: "message:automatic" },
      ],
    } as never;
    expect(userQueuedMessagesInDeliveryOrder(projection).map(({ run }) => run.id)).toEqual([
      "run:user",
    ]);
  });
});
