# Computer use

The `computer_*` MCP tools drive the macOS apps on the machine that runs the environment server.
They are served by the `cogenly` MCP server, so Claude and Codex get the same tools and the same
audit trail; neither provider's own computer use is involved. Claude Code's built-in
`--computer-use-mcp` server only attaches to interactive sessions and asks the user to approve each
app in its TUI, and Codex's bundled plugin is a separate app with its own grants.

## No Apple Events

[`macComputerScript.ts`](../../apps/server/src/computerUse/macComputerScript.ts) posts
CoreGraphics events and reads the Accessibility API directly. It never uses `tell application
"System Events"`: Apple Events need a third, per-target-app Automation grant, and a background
server cannot even show that prompt, so the call fails with "not authorized". Agents that fall back
to `osascript` hit exactly that, which is why the prompt tells them not to.

## Grants belong to the server's responsible app

macOS attributes the grants to the app that launched the server: Cogenly when the desktop app runs
it, otherwise the terminal that started `vp run dev` or the CLI. The status reports that name
([`hostAppName`](../../apps/server/src/computerUse/ComputerUseStatus.ts)) rather than assuming
Cogenly. Every probe and action runs in a fresh `osascript` child, and the action checks its own
grant first, so a permission the user turns on is seen on the next call and the status cannot go
stale between check and act. The desktop's `relaunchApp` exists only for a grant that still reads
as missing after the user turned it on.

## Gated like the browser

`enableAgentComputerUse` puts the `computer` capability on the session credential when
`prepareMcpSession` runs, alongside `preview` and `device`. A flipped setting rotates the
credential. Persistent agents get the browser's rule in
[`AgentMcpPolicy`](../../apps/server/src/agents/AgentMcpPolicy.ts): reads always pass, and
unrestricted writes need every sensitive grant.
