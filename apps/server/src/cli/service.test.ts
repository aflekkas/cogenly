import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BootService from "../cloud/bootService.ts";

import { reconcileService, tailLines } from "./service.ts";

describe("tailLines", () => {
  it("returns the whole text when it is shorter than the limit", () => {
    expect(tailLines("one\ntwo\n", 200)).toBe("one\ntwo");
    expect(tailLines("one", 200)).toBe("one");
  });

  it("returns the last lines without a trailing newline", () => {
    expect(tailLines("one\ntwo\nthree\nfour\n", 2)).toBe("three\nfour");
  });

  it("returns nothing for empty input or a non-positive limit", () => {
    expect(tailLines("", 200)).toBe("");
    expect(tailLines("one\ntwo\n", 0)).toBe("");
    expect(tailLines("one\ntwo\n", -3)).toBe("");
  });
});

it.effect("an already-current service still provisions the chat sandbox without reinstalling", () =>
  Effect.gen(function* () {
    let provisions = 0;
    const result = yield* reconcileService().pipe(
      Effect.provide(
        Layer.mock(BootService.BootService)({
          status: Effect.succeed({
            supported: true,
            installed: true,
            current: true,
            unitPath: "/test/cogenly.service",
            logPath: "/test/service.log",
          }),
          provisionSandbox: Effect.sync(() => {
            provisions++;
          }),
          install: () => Effect.die("must not reinstall or restart a current service"),
        }),
      ),
    );
    expect(result.changed).toBe(false);
    expect(provisions).toBe(1);
  }),
);
