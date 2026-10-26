# Computer use

Agents can control your Mac's own apps: read a window's buttons and fields, click, type, press
shortcuts, scroll, and take screenshots. Ask in any thread, for example "turn off the LeechBlock
schedule in Dia", and the agent does it instead of telling you where to click. Every action shows
in the thread's activity.

## Start

Computer use is on for every agent: chats, Work threads, subagents and persistent agents. macOS
needs two permissions granted to Cogenly once:

- **Accessibility**, for clicking, typing and reading other apps' controls.
- **Screen Recording**, for screenshots.

No app can grant these itself. The first time an agent needs one, the thread shows a prompt with
an **Open System Settings** button that opens the right pane with Cogenly already listed; turn on
the switch next to Cogenly. The agent can continue right away, without restarting. The same
status and buttons are in **Settings → Integrations → Agent access**.

If you run the Cogenly server from a terminal instead of the desktop app, macOS asks for the
permissions for that terminal app, and the prompt names it.

## Turn it off

Turn off **Computer use** in **Settings → Integrations → Agent access**. It applies when an agent
session next starts.

Persistent agents can look, click and type with their default permissions. Computer actions require
the execute permission; the browser's permission rules stay the same.

## Servers without a desktop

Computer use controls the machine that runs the Cogenly server. On Linux, including a cloud
server, it is not available; agents are told so and use the browser tools for web pages instead.
