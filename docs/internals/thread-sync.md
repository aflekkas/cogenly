# Thread sync across machines

Paired machines share every thread. The code lives in
[`apps/server/src/threadSync`](../../apps/server/src/threadSync); the peer link
and pairing are in [machines](./machines.md), configuration sync in
[shared state](./sync.md).

## One writer per thread

Each thread has one owner machine, the only one that appends its events. Other
machines keep a replica. `thread_owners` records the owner; a thread without a
row was created here and runs here. `EventSink` refuses any local write to a
thread owned elsewhere or being handed off, inside the write transaction, so
no code path can fork a thread's history. Recovery, usage-limit resume and
pull request polling filter out replicas: a replica shows the owner's run as
running without ever running it.

Events replicate, not projections. The owner's `orchestration_events` rows are
the log; a receiver writes them through `EventSink` with their original ids
under a `command:replica:` command id. Projections, the shell, thread streams
and search then follow unchanged. Reactors skip replica command ids exactly as
they skip T3 imports (`ReplayedCommandIds.ts`), so a replica never starts
work. Batches follow the sender's own sequence with durable per-peer cursors,
like shared state, and stay under 256 KiB.

Metadata that is not an event (owner, epoch, filing, the project's portable
identity) replicates through `thread_replication_meta_log`, filled by triggers.
Project ids are machine-local: a receiver maps the owner's checkout to its own
by remote, or to its scratch project.

Topology is the machine link's star. A spoke sends only threads it owns; the
hub sends a spoke every thread that spoke does not own. A receiver accepts a
thread's events from its recorded owner, or from its pinned hub. It skips a
thread it also runs locally, such as one both machines imported from T3 or a
project chat both created under the same fixed id, rather than interleave two
histories.

Batches carry events and metadata as plain JSON, and the receiver decodes each
item, because a newer build's event type must not stall the stream on an older
one. A thread with an item the receiver cannot decode is held whole: that item
and every later one for the thread wait in `thread_replication_deferred`, in
order, while other threads keep applying and the cursor advances. Startup
replays a held thread once every item of it decodes, so after an update it
catches up in its original order. Payload keys an older build does not know
are dropped from its own copy; it never writes another machine's events back,
so they are lost only where an older machine passes its copy on: a hub relaying
to a third machine, or a thread moved to an older machine.

## Continuing a thread from another machine

The orchestrator asks `RemoteThreadCommands` before dispatching, so every
entry point (WebSocket, MCP, schedules) routes the same way. A command for a
replica goes to its owner over `threads.command.v1`, through the hub when both
machines are spokes. The owner dispatches it through its own intake, pushes the
resulting events back, then answers. When the call returns, the caller's
projection already shows the result. An offline owner is an error, never a
queue: a queued command would run later on a thread whose state the caller
could not see.

Attachment ids begin with their thread's segment. That lets a replica, or the
hub relaying for it, find the owner of an attachment it lacks and copy it on
first read.

## Moving a thread

A move is a two-phase handoff driven by the current owner S:

1. S checks that the thread is idle (no run, pending request, subagent or
   outbox effect) and fences it in the same transaction (`handoff_json`).
2. S pushes the thread's events and asks the target T to commit with its last
   event id and the thread's attachment ids.
3. T refuses if it is behind or lacks the repository. Otherwise it copies the
   attachments, takes ownership at epoch + 1, then re-homes the thread: the
   project maps to T's checkout of the same remote, and a Work worktree path
   moves under T's worktrees directory.
4. S records T as the owner and drops the fence.

Only the owner at epoch e can start the handoff to e + 1, so T answers a
repeated commit for an epoch it already passed as done. If the reply is lost,
the fence stays, and the scheduler retries the commit until T answers.
Releasing the fence after an unanswered commit could leave two owners. A
definite refusal releases it.

Provider sessions do not move. The working directory changes, so T's next turn
takes the existing resume fallback: a fresh native session seeded with the
thread's portable history. A missing worktree is recreated from the branch at
turn start, so only pushed commits travel. Uncommitted or unpushed work blocks
the move unless the caller leaves it behind. Checkpoint refs stay on S;
pre-move diffs and restores are not available on T.

An agent runs where its conversation runs. After its conversation moves, S
hands the agent and its schedules to T in shared state, which accepts an
`ownerMachine` change only when its author is the current owner.

A project move clones each linked repository on T first. It clones rather than
copies: a clone uses T's credentials and carries no machine paths or
half-finished worktrees. Then it moves the project's threads.
