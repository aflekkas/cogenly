# Terminal

In a Work thread, open **Terminal** with the terminal button at the top right or from the right
panel's **+** menu. Chats have no terminal. It has two sections:

- **Agent runs** lists every command the agent ran in the thread. Running
  commands stay at the top; select one to see its full command, working
  directory, output, and how it ended. A dev server that prints a local address
  gets an **Open** button, which follows your **Open links in** setting
  (Cmd/Ctrl-click opens the system browser). **Stop** ends a running command;
  it stays listed with its exit status.
- **Shells** are terminals you open yourself with **+** in the Terminal header.
  They start in the thread's workspace. Double-click a shell's tab, or press F2
  on it, to rename it on this device. Project scripts also open here.

In the run list, Up and Down move between runs, Enter moves focus into the
output, and Esc returns to the list. When the agent starts a command while you
are in a shell, the shell stays selected; the new run appears under Agent runs.

## Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. Cogenly removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when Cogenly restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.
