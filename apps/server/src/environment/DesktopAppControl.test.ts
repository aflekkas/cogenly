// @effect-diagnostics nodeBuiltinImport:off -- The test stands in for the desktop app's control socket.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DesktopAppControl from "./DesktopAppControl.ts";

/** A control socket that answers each request with `answer`, recording what it was sent. */
const fakeDesktop = (
  answer: (request: DesktopAppActivationRequest) => Omit<DesktopAppActivationResponse, "requestId">,
) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cg-ctl-"));
      const address = NodePath.join(directory, "app.sock");
      const received: Array<DesktopAppActivationRequest> = [];
      const server = NodeNet.createServer((socket) => {
        socket.setEncoding("utf8");
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk;
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          const request = JSON.parse(buffer.slice(0, newline)) as DesktopAppActivationRequest;
          received.push(request);
          socket.end(`${JSON.stringify({ ...answer(request), requestId: request.requestId })}\n`);
        });
      });
      await new Promise<void>((resolve) => server.listen(address, resolve));
      return { address, directory, received, server };
    }),
    ({ directory, server }) =>
      Effect.promise(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }),
  );

const addEnvironment = (address: string, input: { ssh: string; name?: string }) =>
  DesktopAppControl.DesktopAppControl.pipe(
    Effect.flatMap((control) => control.addEnvironment(input)),
    Effect.provide(DesktopAppControl.layerAt({ address })),
  );

describe("DesktopAppControl.addEnvironment", () => {
  it.effect("asks the desktop app to add the host and returns what it saved", () =>
    Effect.gen(function* () {
      const desktop = yield* fakeDesktop(() => ({
        version: 1,
        ok: true,
        environmentId: EnvironmentId.make("environment-vps"),
        label: "Contabo VPS",
      }));
      const added = yield* addEnvironment(desktop.address, {
        ssh: " t3vps ",
        name: "Contabo VPS",
      });
      expect(added).toMatchObject({ environmentId: "environment-vps", label: "Contabo VPS" });
      expect(desktop.received).toEqual([
        expect.objectContaining({ type: "add-environment", ssh: "t3vps", name: "Contabo VPS" }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a host that could pass for an ssh option before contacting the app", () =>
    Effect.gen(function* () {
      const desktop = yield* fakeDesktop(() => ({
        version: 1,
        ok: false,
        code: "internal-error",
        message: "unreachable",
      }));
      const error = yield* addEnvironment(desktop.address, {
        ssh: "-oProxyCommand=sh",
      }).pipe(Effect.flip);
      expect(error._tag).toBe("DesktopAppControlInvalidInputError");
      expect(desktop.received).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("tells the user to update a desktop app that cannot read the request", () =>
    Effect.gen(function* () {
      const desktop = yield* fakeDesktop(() => ({
        version: 1,
        ok: false,
        code: "invalid-request",
        message: "The desktop app request is invalid.",
      }));
      const error = yield* addEnvironment(desktop.address, { ssh: "box" }).pipe(Effect.flip);
      expect(error.message).toContain("Update the desktop app");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("explains that no desktop app is listening", () =>
    Effect.gen(function* () {
      const error = yield* addEnvironment(
        NodePath.join(NodeOS.tmpdir(), "cg-ctl-missing", "app.sock"),
        { ssh: "box" },
      ).pipe(Effect.flip);
      expect(error._tag).toBe("DesktopAppControlUnreachableError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("DesktopAppControl.cliCommand", () => {
  const cliCommand = (
    address: string,
    input: Parameters<DesktopAppControl.DesktopAppControl["Service"]["cliCommand"]>[0],
  ) =>
    DesktopAppControl.DesktopAppControl.pipe(
      Effect.flatMap((control) => control.cliCommand(input)),
      Effect.provide(DesktopAppControl.layerAt({ address })),
    );
  const state = {
    supported: true,
    status: "installed",
    installedPath: "/usr/local/bin/cogenly",
    appPath: "/Applications/Cogenly.app",
    upToDate: true,
    onPath: true,
    userDirectory: "/Users/me/.local/bin",
    userDirectoryOnPath: false,
    systemDirectory: "/usr/local/bin",
    recommendedLocation: "system",
  } as const;

  it.effect("asks the desktop app to install and returns the state after it", () =>
    Effect.gen(function* () {
      const desktop = yield* fakeDesktop(() => ({ version: 1, ok: true, cliCommand: state }));
      const result = yield* cliCommand(desktop.address, { action: "install", location: "system" });
      expect(result).toEqual(state);
      expect(desktop.received).toEqual([
        expect.objectContaining({ type: "cli-command", action: "install", location: "system" }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an answer to a different request", () =>
    Effect.gen(function* () {
      const desktop = yield* fakeDesktop(() => ({
        version: 1,
        ok: true,
        environmentId: EnvironmentId.make("environment-vps"),
        label: "VPS",
      }));
      const error = yield* cliCommand(desktop.address, { action: "status" }).pipe(Effect.flip);
      expect(error.message).toContain("answered a different request");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
