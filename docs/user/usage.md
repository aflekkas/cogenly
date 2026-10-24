# Usage limits

Open **Usage** from the sidebar or the command palette, or press `mod+u` on web and
desktop when the terminal is not focused. Customize `usage.open` in
**Settings → Keybindings**.

## Track subscription limits

**Usage** pools every subscription account it can see per provider, so with several Codex
or Claude accounts across your environments and hubs you read one number per window rather than a
list. Each window card shows how much of the pool is left and a bar with one segment per account,
kept in the same column across windows. Accounts are ordered by their 5-hour reset, soonest
first, or by the first available window when no account reports a 5-hour limit. A gap means the
account does not report that window. When the provider reports reset times, the card also says
when the next reset lands and how much it hands back. The hatched
part of a segment is what that reset restores. Tap a segment or account row for the account's plan,
where it is signed in, and its reset time. On web, you can hover too. Codex and Claude accounts
with banked reset credits show a ticket count and the **Use reset** action in the account details.
Claude resets are not available when the server runs on macOS, where Claude keeps its login in the
Keychain. On narrow screens, numbered rows below
the bar show each account's quota, countdown, and credits. Tap a row to open its details.

Bars show quota remaining and drain as you spend. To see quota used fill up instead, choose
**Used** under **Settings → Appearance → Usage meters**. It is a per-device choice and applies to the bars, percentages and the notice above the composer. The
even-pace line moves with it: it marks time left when bars drain and time elapsed when they fill.

The same account signed in on more than one environment, or reported by a hub as well, counts once.
With more than one environment, filter with the environment dropdown to see what a single
machine has.

Opening Usage checks the selected connected environments automatically. Each client waits at
least five minutes between automatic checks of an environment, including after a failed check.
If a window still looks stale, refresh Usage to re-check every provider and hub.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage**.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Continue on another account when a limit hits

When a turn stops on a usage limit and another provider account still has room, the notice above
the composer offers **Continue on** that account. Cogenly suggests a second account of the same
provider and model first, then another signed-in provider, preferring accounts with known headroom.
One click switches the thread, hands it the conversation, and re-runs your last request, so there
is nothing to retype. A resume scheduled for the reset is cancelled so the turn does not run twice.
The arrow beside it lists the other accounts with how much each has left, and lets you stop
suggesting for this limit.

Agents see the same headroom: `orchestrator_capabilities` reports each account's remaining usage,
so you can ask an agent to delegate to the account with room. An agent can also continue a stopped
thread on another account when you ask it to.

A short-term rate limit is not a spent quota. When a provider throttles requests rather than
reporting an exhausted window, the thread retries on its own after a short wait, backing off from a
minute up to fifteen, for up to five tries in a row. The notice above the composer shows the next
try, and **Don't resume** stops it.

Tasks an agent delegates recover without you. A delegated task that stops on a limit moves to the
best account with room, keeping its conversation, and the agent that delegated it is told where it
went. When no account has room, it resumes at the reset instead, and the delegating agent waits for
it. Turn off its resume from the task's own thread to stop it there.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The accounts appear under **Usage**. Codex accounts show banked reset credits; select an
account and choose **Use reset** to redeem one. No hub plugin is required.

This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.

## Subscription usage widget

Add **Subscription usage** from your iOS or Android widget gallery to see remaining Codex and
Claude quotas. Tap it to open **Usage**; on Android this works while Cogenly is running in
the background, otherwise open the app from the launcher. On iOS, use **Edit Widget** to choose
Session, Weekly, or both for each provider. Reopen Cogenly to refresh expired readings.

## Keyboard shortcuts

On web and desktop, open Usage from the command palette. Press `Escape` to return to the
previous page. Customize `usage.open` in **Settings → Keybindings**.
