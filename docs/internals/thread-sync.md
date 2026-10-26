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
order, while other threads keep applying and the cursor advances. Replay runs
at startup, hourly, on a peer version change, and through machine health Fix.
A held thread catches up in its original order once every item decodes. Readable events keep their raw JSON when
schema decoding drops fields; event data, metadata extensions and command
receipts survive relaying and later ownership changes. Receipts travel with
events and remap their result sequence to the receiving log. A projection
failure quarantines that thread's incoming items with a reason while other threads advance.
Held incoming history is bounded; a capacity-trimmed quarantine must be discarded, never
partially replayed. The explicit per-thread health Fix drops only held incoming rows,
leaves local history intact, and logs the discarded count. Lock timeouts retry without advancing the cursor
or quarantining the batch.

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
2. S pushes the thread's events and idempotency receipts, then asks the target T
   to commit with its last event id, event count and attachment ids. Receipt
   transfer has its own capability check; an older target refuses the move.
3. T refuses if it has a gap, unreadable events or lacks the repository.
   Otherwise it copies the attachments and atomically takes ownership at epoch + 1
   with the thread's new local paths: the
   project maps to T's checkout of the same remote, and a Work worktree path
   moves under T's worktrees directory.
4. S records T as the owner and drops the fence.

Only the owner at epoch e can start the handoff to e + 1, so T answers a
repeated commit for an epoch it already passed as done. If the reply is lost,
the fence stays, and the scheduler retries the commit until T answers.
Releasing the fence after an unanswered commit could leave two owners. A
definite refusal releases it. New-owner replication can also complete the
source's fence before the commit reply arrives; its events must apply in that
same receive pass. The hub records handoffs it relays and rejects other peers'
unwitnessed ownership claims, even when the old owner was unpaired.

Provider sessions do not move. The working directory changes, so T's next turn
takes the existing resume fallback: a fresh native session seeded with the
thread's portable history. A missing worktree is recreated from the branch at
turn start, so only pushed commits travel. Uncommitted or unpushed work blocks
the move unless the caller leaves it behind. Checkpoint refs stay on S;
pre-move diffs and restores are not available on T. Rollback checks the local
checkpoint ref and scope cwd before creating a worktree or opening a provider.

Recovery from a permanently lost machine is an explicit local action on the
hub (or a survivor after unpairing a lost hub), never a peer's ownership claim.
Only unpaired owners qualify. Busy threads, unreadable history and agent
conversations are refused: ownership recovery must not restart autonomous or
unfinished work. A dry-run lists the affected owner ids before recovery.

An agent runs where its conversation runs. After its conversation moves, S
hands the agent and its schedules to T in shared state, which accepts an
`ownerMachine` change only when its author is the current owner.

A project move gets T a checkout of each linked repository first. A checkout
of the same remote already on T that no other project claims is filed into the
project in place (`localCheckout.ts`); otherwise T clones it. It clones rather
than copies: a clone uses T's credentials and carries no machine paths or
half-finished worktrees. Then it moves the project's threads.

A thread whose project is a scratch folder on S (S's "No project", or a T3
Code scratch folder an older import recorded as a repository) maps to T's
"No project", which the commit creates if T has none yet.

## Launching on another machine

A new thread is created by its target, which owns its first event and runs its
first turn. `ThreadLaunchService` routes through the launch registry and the
typed peer channel; transports and schedulers use that same service. Targets
resolve a project by its shared label and repository remote, adopting a local
checkout or cloning it with their own credentials. Absolute worktree paths
cannot be used remotely. Offline targets refuse work instead of queuing it.

Shared provider session ids include their machine identity, since provider instance names are local.

A delegated child and its parent may have different owners. The child owns its
conversation; task bookkeeping and completion wakes belong to the parent.
Delegation fetches the child's bounded event pages over a separate peer channel,
before attaching it and while its result is pending. These pages never advance
the bulk replication cursors: a backlog on an unrelated thread must not block
task handles, reads, cancellation, or parent wakes. Parent-side launch intents
remain durable until attachment commits; failed creation and restart recovery
cancel unadopted children directly on their owner. Older peers without this
channel refuse delegation before a child starts.

Replicated terminal events settle that local parent without promoting the
replicated child's queue. Before publishing a result the parent checks the
child owner's recovery state, since restart continuations and pending effects
are local, not replicated. The normal recovery pass retries this after a lost
connection. Worktree delegation transfers the parent's commit in a bounded Git
bundle before preparation; uncommitted files never travel. Reading a terminal
task can fetch its committed result branch back without forcing a local ref.

Schedules have a timer owner and an optional run target. Configuration edits
and manual runs go through the timer owner; each fresh-thread firing goes
through the launch service and records an offline target as a failed run.
