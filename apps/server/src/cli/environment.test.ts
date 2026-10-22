import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { Command } from "effect/cli";

import { type EnvironmentAddFlags, makeEnvironmentCommand } from "./environment.ts";

/** Parses `argv` as `cogenly environment …` and returns the flags `add` received, if it ran. */
const parse = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let received: EnvironmentAddFlags | null = null;
    const command = makeEnvironmentCommand((flags) =>
      Effect.sync(() => {
        received = flags;
      }),
    );
    const exit = yield* Command.runWith(command, { version: "test", renderErrors: false })(
      argv,
    ).pipe(Effect.exit);
    return { ran: Exit.isSuccess(exit), flags: received as EnvironmentAddFlags | null };
  }).pipe(Effect.provide(NodeServices.layer));

describe("cogenly environment add", () => {
  it.effect("reads the SSH alias and display name", () =>
    Effect.gen(function* () {
      const { ran, flags } = yield* parse(["add", "--ssh", "t3vps", "--name", "Contabo VPS"]);
      expect(ran).toBe(true);
      expect(flags).toEqual({
        baseDir: Option.none(),
        ssh: "t3vps",
        name: Option.some("Contabo VPS"),
        json: false,
      });
    }),
  );

  it.effect("leaves the name to the desktop when it is omitted", () =>
    Effect.gen(function* () {
      const { flags } = yield* parse(["add", "--ssh", "box", "--json"]);
      expect(flags).toMatchObject({ ssh: "box", name: Option.none(), json: true });
    }),
  );

  it.effect("requires the SSH host", () =>
    Effect.gen(function* () {
      const { ran, flags } = yield* parse(["add", "--name", "VPS"]);
      expect(ran).toBe(false);
      expect(flags).toBeNull();
    }),
  );
});
