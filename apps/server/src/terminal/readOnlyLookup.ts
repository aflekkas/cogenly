/**
 * What a lookup sandbox hides from an otherwise readable host. Only chat
 * (read-only lookup) terminals are sandboxed: full-access agents are
 * intentionally unsandboxed and can read all of this.
 */
export interface LookupMasks {
  /**
   * Cogenly state and credential stores. `missing` paths are hidden on macOS
   * only, since Linux can mount only over a path that already exists.
   */
  readonly hidden: ReadonlyArray<{
    readonly path: string;
    readonly kind: "directory" | "file" | "missing";
  }>;
  /** Workspace roots inside a hidden directory, such as Cogenly's worktrees. */
  readonly reexposed: ReadonlyArray<string>;
  /** Cogenly's own HTTP/WS port, refused on loopback where the platform allows it. */
  readonly serverPort: number | null;
}

export const noLookupMasks: LookupMasks = { hidden: [], reexposed: [], serverPort: null };

const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

/**
 * Ordered hide/show steps. Later steps win on both platforms: Seatbelt takes
 * the last matching rule and bwrap mounts in argument order. Hidden paths
 * inside a re-exposed root are hidden again after it.
 */
export const lookupMaskSteps = (masks: LookupMasks) => {
  const reexposed = masks.reexposed.filter((root) =>
    masks.hidden.some(
      (hidden) => hidden.kind === "directory" && root !== hidden.path && within(root, hidden.path),
    ),
  );
  const outermost = masks.hidden.filter(
    (entry) =>
      !masks.hidden.some(
        (other) =>
          other !== entry &&
          other.kind !== "file" &&
          other.path !== entry.path &&
          within(entry.path, other.path),
      ),
  );
  return [
    ...outermost.map((entry) => ({ hide: entry }) as const),
    ...reexposed.map((path) => ({ show: path }) as const),
    ...masks.hidden
      .filter((entry) => reexposed.some((root) => within(entry.path, root)))
      .map((entry) => ({ hide: entry }) as const),
  ];
};

const macMaskRules = (masks: LookupMasks): string =>
  lookupMaskSteps(masks)
    .map((step) =>
      "show" in step
        ? `(allow file-read* (subpath ${JSON.stringify(step.show)}))`
        : `(deny file-read* (subpath ${JSON.stringify(step.hide.path)}))`,
    )
    .join("\n");

/** A deny-by-default Seatbelt profile; children inherit it across fork and exec. */
export const macReadOnlyProfile = (
  temporaryDirectory: string,
  masks: LookupMasks = noLookupMasks,
): string => `
(version 1)
(deny default)
(allow file-read*)
${macMaskRules(masks)}
(allow process-exec process-fork)
(allow process-info* signal (target same-sandbox))
(allow sysctl-read)
(allow system-info)
(allow file-write* (subpath ${JSON.stringify(temporaryDirectory)}))
(allow file-write-data file-ioctl (literal "/dev/null") (literal "/dev/tty"))
(allow network-outbound (remote ip "*:*"))
${
  // Seatbelt filters remote hosts only as "*" or "localhost", so a server also
  // bound to a LAN or tailnet address stays reachable there. Its routes still
  // need credentials, which the masks above hide.
  masks.serverPort === null
    ? ""
    : `(deny network-outbound (remote ip ${JSON.stringify(`localhost:${masks.serverPort}`)}))`
}
(allow network-bind (local ip "*:*"))
(allow system-socket (socket-domain AF_INET) (socket-domain AF_INET6) (socket-domain AF_UNIX))
; macOS libc resolves DNS through this socket, not an Internet socket.
(allow network-outbound
  (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
; DNS and certificate validation only, never launchd, Apple Events or task ports.
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.mDNSResponder")
  (global-name "com.apple.trustd.agent"))
`;

/**
 * Network namespaces would disable lookups. Seccomp instead allows only Internet
 * sockets, including blocking abstract Unix sockets invisible to mount isolation.
 * Reject other ABIs (including x32) so compat syscalls cannot bypass the filter.
 */
export const linuxReadOnlySeccomp = (architecture: string): Uint8Array | null => {
  const abi =
    architecture === "x64"
      ? {
          audit: 0xc000003e,
          socket: 41,
          denied: {
            socketpair: 53,
            ptrace: 101,
            mount: 165,
            umount2: 166,
            reboot: 169,
            init_module: 175,
            delete_module: 176,
            kexec_load: 246,
            add_key: 248,
            request_key: 249,
            keyctl: 250,
            perf_event_open: 298,
            open_by_handle_at: 304,
            setns: 308,
            process_vm_readv: 310,
            process_vm_writev: 311,
            kcmp: 312,
            finit_module: 313,
            bpf: 321,
            userfaultfd: 323,
            io_uring_setup: 425,
            io_uring_enter: 426,
            io_uring_register: 427,
            pidfd_getfd: 438,
          },
        }
      : architecture === "arm64"
        ? {
            audit: 0xc00000b7,
            socket: 198,
            denied: {
              socketpair: 199,
              ptrace: 117,
              mount: 40,
              umount2: 39,
              reboot: 142,
              init_module: 105,
              delete_module: 106,
              kexec_load: 104,
              add_key: 217,
              request_key: 218,
              keyctl: 219,
              perf_event_open: 241,
              open_by_handle_at: 265,
              setns: 268,
              process_vm_readv: 270,
              process_vm_writev: 271,
              kcmp: 272,
              finit_module: 273,
              bpf: 280,
              userfaultfd: 282,
              io_uring_setup: 425,
              io_uring_enter: 426,
              io_uring_register: 427,
              pidfd_getfd: 438,
            },
          }
        : null;
  if (!abi) return null;
  const instructions: number[][] = [
    [0x20, 0, 0, 4], // seccomp_data.arch
    [0x15, 1, 0, abi.audit],
    [0x06, 0, 0, 0x80000000], // KILL_PROCESS for foreign ABIs
    [0x20, 0, 0, 0], // syscall number
    [0x35, 0, 1, 0x40000000], // x32 syscall bit
    [0x06, 0, 0, 0x80000000],
  ];
  for (const syscall of Object.values(abi.denied)) {
    instructions.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x00050001]); // EPERM
  }
  instructions.push(
    [0x15, 0, 4, abi.socket],
    [0x20, 0, 0, 16], // first argument: domain
    [0x15, 2, 0, 2], // AF_INET
    [0x15, 1, 0, 10], // AF_INET6
    [0x06, 0, 0, 0x00050001],
    [0x06, 0, 0, 0x7fff0000], // ALLOW
  );
  const buffer = new ArrayBuffer(instructions.length * 8);
  const view = new DataView(buffer);
  instructions.forEach(([code, jt, jf, k], index) => {
    view.setUint16(index * 8, code!, true);
    view.setUint8(index * 8 + 2, jt!);
    view.setUint8(index * 8 + 3, jf!);
    view.setUint32(index * 8 + 4, k!, true);
  });
  return new Uint8Array(buffer);
};

/**
 * Empty tmpfs over hidden directories and /dev/null over hidden files. A mount
 * namespace cannot filter connect() by port and a network namespace would
 * disable lookups, so Linux leaves Cogenly's port reachable; its routes still
 * need credentials, which these masks hide.
 */
const linuxMaskArguments = (masks: LookupMasks): string[] =>
  lookupMaskSteps(masks).flatMap((step) =>
    "show" in step
      ? ["--ro-bind", step.show, step.show]
      : step.hide.kind === "directory"
        ? ["--tmpfs", step.hide.path]
        : step.hide.kind === "file"
          ? ["--ro-bind", "/dev/null", step.hide.path]
          : [],
  );

export const linuxReadOnlyArguments = (input: {
  readonly shell: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly masks?: LookupMasks;
}): string[] => [
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
  "/",
  "/",
  "--proc",
  "/proc",
  "--remount-ro",
  "/proc",
  "--dev",
  "/dev",
  "--tmpfs",
  "/tmp",
  // Preserve the launch folder even when it lives below a masked temp mount.
  ...(["/tmp/"].some((root) => input.cwd.startsWith(root))
    ? ["--ro-bind", input.cwd, input.cwd]
    : []),
  ...linuxMaskArguments(input.masks ?? noLookupMasks),
  "--setenv",
  "TMPDIR",
  "/tmp",
  "--chdir",
  input.cwd,
  "--seccomp",
  "3",
  "--",
  input.shell,
  ...input.args,
];

/**
 * node-pty closes non-stdio descriptors before exec. This trusted prelude opens
 * only a read-only filter fd, which bwrap consumes and closes before the shell.
 * No user text is interpreted until confinement is installed.
 */
export const linuxSandboxPrelude = 'exec 3<"$1"; shift; exec "$@"';
