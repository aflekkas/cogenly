# Terminal

In a Work thread, the terminal panel sits under the conversation and shows the commands the
agents ran. Open it with the panel button at the top right, `mod+J`, or **Show output** on a
command in the conversation. Chats have no terminal.

The panel never opens by itself.

Each agent that ran a command gets a tab: the thread's own agent, and each subagent with its
own conversation. A tab lists that agent's commands under **Running** and **Finished**; click a
heading to fold it. A long Finished list starts folded while commands run. Select one to see
its full command, working directory, output, and how it ended. A dev server that prints a local
address gets an **Open** button, which follows your **Open links in** setting (Cmd/Ctrl-click
opens the system browser). **Stop** ends a running command; it stays listed with its exit
status.

Closing a tab hides it until that agent runs another command. Drag the panel's top edge to
resize it; a short, narrow panel swaps the list for a menu beside the command. Each thread
remembers whether its panel was open, how tall it was, and which lists you folded.

In the command list, Up and Down move between commands, Enter moves focus into the output, and
Esc returns to the list.

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
