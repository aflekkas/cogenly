/** A deny-by-default Seatbelt profile; children inherit it across fork and exec. */
export const macReadOnlyProfile = (temporaryDirectory: string): string => `
(version 1)
(deny default)
(allow file-read*)
(allow process-exec process-fork)
(allow process-info* signal (target same-sandbox))
(allow sysctl-read)
(allow system-info)
(allow file-write* (subpath ${JSON.stringify(temporaryDirectory)}))
(allow file-write-data file-ioctl (literal "/dev/null") (literal "/dev/tty"))
(allow network-outbound (remote ip "*:*"))
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

export const linuxReadOnlyArguments = (input: {
  readonly shell: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
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
