import { describe, expect, it } from "@effect/vitest";
import {
  linuxReadOnlyArguments,
  linuxReadOnlySeccomp,
  linuxSandboxPrelude,
  macReadOnlyProfile,
} from "./readOnlyLookup.ts";

// Interpret the small classic BPF subset we emit, so the tests assert syscall
// decisions instead of copying filter bytes.
const decision = (architecture: string, audit: number, syscall: number, domain = 0) => {
  const program = linuxReadOnlySeccomp(architecture)!;
  const view = new DataView(program.buffer, program.byteOffset, program.byteLength);
  let accumulator = 0;
  for (let offset = 0; offset < program.length; offset += 8) {
    const code = view.getUint16(offset, true);
    const k = view.getUint32(offset + 4, true);
    if (code === 0x20) accumulator = k === 4 ? audit : k === 0 ? syscall : domain;
    else if (code === 0x06) return k;
    else {
      const matches = code === 0x15 ? accumulator === k : accumulator >= k;
      offset += view.getUint8(offset + (matches ? 2 : 3)) * 8;
    }
  }
  throw new Error("Filter did not return");
};

describe("read-only launch generation", () => {
  it("allows only private temp writes and selected devices on macOS", () => {
    const directory = '/private/tmp/lookup "quoted"';
    const profile = macReadOnlyProfile(directory);
    expect(profile).toContain("(deny default)");
    expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(directory)}))`);
    expect(profile).toContain("(target same-sandbox)");
    expect(profile).toContain('(remote ip "*:*")');
    expect(profile).not.toContain("(allow network*)");
    expect(profile).toContain('(path-literal "/private/var/run/mDNSResponder")');
    expect(profile).not.toContain("(allow network-outbound (remote unix-socket (subpath");
    expect(profile).not.toContain('(global-name "com.apple.launchd")');
    expect(profile).not.toContain("(allow mach-priv-task-port");
  });
  it("keeps host mounts read-only with private process, IPC and temporary state on Linux", () => {
    const args = linuxReadOnlyArguments({
      shell: "/bin/sh",
      args: ["-c", 'echo "$HOME"'],
      cwd: "/project folder",
    });
    expect(args.slice(0, 10)).toEqual([
      "--unshare-user",
      "--disable-userns",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--new-session",
      "--die-with-parent",
      "--cap-drop",
      "ALL",
      "--ro-bind",
    ]);
    expect(args).toContain("--seccomp");
    expect(args).not.toContain("--share-net");
    expect(args).not.toContain("--unshare-net");
    expect(args.slice(-4)).toEqual(["--", "/bin/sh", "-c", 'echo "$HOME"']);
    expect(linuxSandboxPrelude).toBe('exec 3<"$1"; shift; exec "$@"');
    expect(linuxReadOnlyArguments({ shell: "/bin/sh", args: [], cwd: "/tmp/project" })).toContain(
      "/tmp/project",
    );
  });
  const masks = {
    hidden: [
      { path: "/home/u/.cogenly", kind: "directory" },
      { path: "/home/u/.cogenly/userdata", kind: "directory" },
      { path: "/home/u/.claude.json", kind: "file" },
      { path: "/home/u/.netrc", kind: "missing" },
      { path: "/home/u/.cogenly/projects/repo/.codex", kind: "directory" },
    ],
    reexposed: ["/home/u/.cogenly/worktrees", "/home/u/.cogenly/projects", "/elsewhere"],
    serverPort: 4773,
  } as const;
  it("hides Cogenly state and credentials on macOS, re-exposing workspaces inside them", () => {
    const profile = macReadOnlyProfile("/private/tmp/lookup", masks);
    const rules = profile.split("\n");
    const at = (rule: string) => rules.indexOf(rule);
    const hide = (path: string) => `(deny file-read* (subpath ${JSON.stringify(path)}))`;
    const show = (path: string) => `(allow file-read* (subpath ${JSON.stringify(path)}))`;
    expect(at("(allow file-read*)")).toBeLessThan(at(hide("/home/u/.cogenly")));
    expect(at(hide("/home/u/.cogenly"))).toBeLessThan(at(show("/home/u/.cogenly/worktrees")));
    for (const path of ["/home/u/.claude.json", "/home/u/.netrc"])
      expect(profile).toContain(hide(path));
    // A secret inside a re-exposed root is hidden again after it.
    expect(rules.lastIndexOf(hide("/home/u/.cogenly/projects/repo/.codex"))).toBeGreaterThan(
      at(show("/home/u/.cogenly/projects")),
    );
    // Roots outside every hidden path never widen access.
    expect(profile).not.toContain(show("/elsewhere"));
    expect(profile).toContain('(deny network-outbound (remote ip "localhost:4773"))');
    expect(at('(allow network-outbound (remote ip "*:*"))')).toBeLessThan(
      at('(deny network-outbound (remote ip "localhost:4773"))'),
    );
    expect(macReadOnlyProfile("/private/tmp/lookup")).not.toContain("(deny file-read*");
  });
  it("masks existing hidden paths with tmpfs or /dev/null on Linux", () => {
    const args = linuxReadOnlyArguments({ shell: "/bin/sh", args: [], cwd: "/srv", masks });
    const joined = args.join(" ");
    expect(joined).toContain("--tmpfs /home/u/.cogenly --ro-bind /dev/null /home/u/.claude.json");
    expect(joined).toContain("--ro-bind /home/u/.cogenly/worktrees /home/u/.cogenly/worktrees");
    expect(joined).toContain(
      "--ro-bind /home/u/.cogenly/projects /home/u/.cogenly/projects --tmpfs /home/u/.cogenly/projects/repo/.codex",
    );
    // Missing paths cannot be mounted over, and nested hidden paths are covered already.
    expect(args).not.toContain("/home/u/.netrc");
    expect(args).not.toContain("/home/u/.cogenly/userdata");
    expect(args.indexOf("/home/u/.cogenly")).toBeGreaterThan(args.indexOf("/tmp"));
    expect(args.indexOf("/home/u/.cogenly")).toBeLessThan(args.indexOf("--seccomp"));
  });
  it.each([
    ["x64", 0xc000003e, 41, 53, 101],
    ["arm64", 0xc00000b7, 198, 199, 117],
  ] as const)(
    "restricts socket and process-control syscalls for %s",
    (arch, audit, socket, pair, ptrace) => {
      expect(decision(arch, audit, socket, 1)).toBe(0x00050001); // AF_UNIX, including abstract sockets
      for (const domain of [2, 10]) expect(decision(arch, audit, socket, domain)).toBe(0x7fff0000);
      for (const call of [pair, ptrace, 425, 426, 427, 438])
        expect(decision(arch, audit, call)).toBe(0x00050001);
      expect(decision(arch, audit, 0)).toBe(0x7fff0000);
      expect(decision(arch, 0x40000003, socket, 2)).toBe(0x80000000);
      expect(decision(arch, audit, socket | 0x40000000, 2)).toBe(0x80000000);
    },
  );
  it("refuses unsupported Linux ABIs", () => {
    expect(linuxReadOnlySeccomp("ia32")).toBeNull();
    expect(linuxReadOnlySeccomp("riscv64")).toBeNull();
  });
});
