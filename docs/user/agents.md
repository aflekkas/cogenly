# Agents

Agents are persistent assistants with a responsibility, their own conversation, memory,
and triggers. Use one for ongoing work such as watching pull requests or following up
on commitments. Coding sessions they start appear in Work with the agent's name.

## Create and talk to an agent

Choose **New agent** in the Agents sidebar or command palette and describe what it
should take care of. The builder proposes an agent; keep talking to adjust it, then
choose **Create**. Review its responsibility, permissions, triggers, and **Runs on**
machine before creating it. If this machine cannot offer a No project workspace,
the builder uses an existing repository; open a repository first if there is none.

Open the agent to give it direction or ask it to start Work. **Details** holds its
standing instructions, permissions, triggers, open items, memory, and recent activity.
An agent can suggest changes that need your approval, and learns when you approve or
reject them. New agents can read, draft, and start Work. Sending externally, creating
pull requests, merging, deploying, and deleting need their corresponding grants.

## Triggers and models

Triggers wake an agent on an interval, at a chosen time, through a webhook, or when
something happens, such as Work finishing or pull request checks failing. Add them
in **Details → Schedule**, through **Settings → Scheduled tasks**, or by approving
an agent's proposal. **Run now** starts a time-based trigger manually; events and
webhooks need their actual source event or request.

A busy agent defers a time-based fire until its current job finishes. Skipped fires
show their reason, such as the daily run cap or a pause after failures. Restarting
Cogenly does not add a provider failure. Turn a trigger off under **Schedule** to
pause it, and turn it back on to resume. Pausing triggers still lets you message
the agent.

Replies and Work use the agent's selected model. Ask it to set a fallback chain if
you want another provider or model when one hits its usage limit or signs out. An
eligible failed run retries once on the next entry. The primary is tried again at
the provider's reset time, or after an hour when no reset time is available.

## Memory and deleting

Agents can propose facts to remember. Review, confirm, correct, or forget them under
**Details → Memory** or **Settings → Memory**; see [Memory](memory-and-export.md#memory).
Proposed open items also need your confirmation.

Delete an agent from its row menu or **Details → Advanced**. This stops its work and
removes its triggers and proposed open items. Confirmed open items return to you.
Its conversation remains available as a normal thread.

## Which machine runs it

With [paired machines](machines.md), a new agent defaults to the online hub so it
can keep working while your laptop is closed. Otherwise it starts locally. Change
**Runs on** in the builder proposal to choose another online machine. Existing agents
keep their owner until you move them.

Each agent runs once, on its owner. You can read and message its conversation from
another paired machine; sends run on the owner. Profile edits and deletion also go
to the owner, which must be online. The Agents list shows the owner's name and
availability. While it is offline, sending is disabled; reading still works.
