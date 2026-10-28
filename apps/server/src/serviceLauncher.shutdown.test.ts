// @effect-diagnostics nodeBuiltinImport:off
// Launcher tests exercise the Node-only process boundary without a server or database.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";

import { Launcher } from "./serviceLauncher.ts";
import { LAUNCHER_SHUTDOWN_GRACE_MS } from "./shutdownDeadline.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

it("bounds a stop queued behind a stalled launcher transition", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cogenly-stalled-launcher-"));
  await NodeFSP.mkdir(NodePath.join(root, "runtime"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string>();
  vi.mocked(NodeFSP.readFile).mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const forced = new Error("forced process exit");
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw forced;
  });
  const launcher = new Launcher(root, { protocol: 3, activeVersion: "0.3.7" });
  // No runtime is installed: once released, recovery fails and cleans up its listeners.
  const running = launcher.run().catch(() => undefined);
  try {
    await entered.promise;
    const stopped = launcher.stop("SIGTERM");
    await expect(vi.advanceTimersByTimeAsync(LAUNCHER_SHUTDOWN_GRACE_MS)).rejects.toBe(forced);
    expect(exit).toHaveBeenCalledWith(0);
    expect(await NodeFSP.stat(NodePath.join(root, "runtime/.service-stopping"))).toBeDefined();
    release.resolve("");
    await stopped;
    await running;
  } finally {
    release.resolve("");
    await running;
    vi.restoreAllMocks();
    vi.useRealTimers();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("clears a deferred restart marker after the trial commits", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cogenly-committed-launcher-"));
  const runtime = NodePath.join(root, "runtime/versions/0.3.7");
  const marker = NodePath.join(root, "runtime/.restart-pending");
  await NodeFSP.mkdir(runtime, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(runtime, ".install-complete"), "0.3.7");
  await NodeFSP.writeFile(
    NodePath.join(runtime, "cogenly"),
    `#!${process.execPath}
process.on("SIGTERM", () => process.exit(0));
process.on("message", () => {});
process.send({ type: "prepared", updateId: "trial" });
`,
    { mode: 0o700 },
  );
  await NodeFSP.writeFile(NodePath.join(root, "db.sqlite"), "fixture database");
  await NodeFSP.writeFile(marker, "0.3.7\n");
  const committed = Promise.withResolvers<void>();
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(NodeChildProcess.spawn).mockImplementation((command, args, options) => {
    const child = actual.spawn(command, args, options);
    const send = child.send.bind(child);
    vi.spyOn(child, "send").mockImplementation((...sendArgs: Parameters<typeof child.send>) => {
      const result = send(...sendArgs);
      if ((sendArgs[0] as { type?: string }).type === "committed") committed.resolve();
      return result;
    });
    child.once("error", committed.reject);
    return child;
  });
  const launcher = new Launcher(root, {
    protocol: 3,
    activeVersion: "0.3.6",
    update: {
      id: "trial",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      status: "pending",
      dbPath: NodePath.join(root, "db.sqlite"),
    },
  });
  const running = launcher.run();
  running.catch(committed.reject);
  try {
    await committed.promise;
    await expect(NodeFSP.stat(marker)).rejects.toHaveProperty("code", "ENOENT");
    expect(
      JSON.parse(await NodeFSP.readFile(NodePath.join(root, "runtime/service-state.json"), "utf8")),
    ).toMatchObject({
      activeVersion: "0.3.7",
      update: { status: "committed" },
    });
  } finally {
    await launcher.stop("SIGTERM");
    await running;
    vi.restoreAllMocks();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
