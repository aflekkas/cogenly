import { defaultAgentOwner } from "@cogenly/contracts";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";
import { useNavigate } from "@tanstack/react-router";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProjectLabelId,
  ThreadId,
} from "@cogenly/contracts";
import { squashAtomCommandFailure } from "@cogenly/client-runtime/state/runtime";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { XIcon } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { agentAppearance, type AgentFaceProps } from "~/components/agents/face";
import { avatarFaceProps } from "~/components/agents/face/agentAvatar.logic";
import { ComposerControl } from "~/components/chat/ComposerControl";
import { ComposerPrimaryActions } from "~/components/chat/ComposerPrimaryActions";
import { ComposerSurface } from "~/components/chat/ComposerSurface";
import { Button } from "~/components/ui/button";
import { SidebarInset } from "~/components/ui/sidebar";
import { toastManager } from "~/components/ui/toast";
import { useScratchProject } from "~/hooks/useScratchProject";
import { prefersReducedMotion } from "~/lib/sendMotion";
import { cn, newMessageId, randomUUID } from "~/lib/utils";
import { ComposerProjectChip } from "~/projectLabels/ComposerProjectPicker";
import { agentsRpc } from "~/rpc/agents";
import { useProjects, useThreadShells } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { threadEnvironment, useEnvironmentThread } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { useUiStateStore } from "~/uiStateStore";
import { accentForColor, accentStyle, NEUTRAL_ACCENT } from "./agentAccent.logic";
import { noteAgentArrival } from "./agentArrivals";
import {
  BUILDER_EXAMPLES,
  canCreateProposal,
  proposalFromMessages,
  proposalFromTurnItems,
  proposalProjectFolderId,
  proposalToDraft,
  proposalTriggers,
  stripProposal,
} from "./agentBuilder.logic";
import { AgentIdentity, AgentIdentityPerson, motionToken } from "./AgentIdentity";
import { AgentProjectPicker, useAgentProjectFolders } from "./AgentProjectPicker";
import { AgentProposalCard } from "./AgentProposalCard";
import { AgentTypingDots } from "./AgentTypingBubble";
import {
  INITIAL_TYPING_SLOT,
  agentContactKey,
  conversationRows,
  modelDisplayName,
  stepTypingSlot,
  type TypingSlotState,
} from "./agents.logic";
import {
  AgentCreatedWithoutTriggerError,
  LiveModelControls,
  useAgents,
  useAgentsClient,
  useDefaultAgentModel,
  workingOnFromItems,
} from "./agentsClient";
import type { AgentContact, AgentMessage } from "./agents.types";
import { useMessageMotion } from "./useMessageMotion";

const LIVE_RUN = new Set(["preparing", "queued", "starting", "running"]);
const BUILDER_SHAPE = agentAppearance("new-friend").shape;
/**
 * The builder's own face: the mono cloud, until the proposal's face takes over. It
 * carries the agent's seed, so the face morphs into the proposed one instead of
 * being replaced by it.
 */
const builderFace = (seed: string): AgentFaceProps => ({
  seed,
  shape: BUILDER_SHAPE,
  expression: "curieux",
  color: "currentColor",
  paper: "none",
  className: "text-foreground/90",
});
/**
 * The empty state introduces the agent with its face and name; once the
 * conversation starts they move up into the header (`playHeroMove`) while the
 * copy fades. A failed first send brings the empty state back (`returning`): the
 * header's person fades out as the hero fades in.
 */
type HeroPhase = "shown" | "leaving" | "gone" | "returning";

interface BuilderThread {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  /** The project folder the builder conversation was filed in. */
  projectFolderId: ProjectLabelId | null;
}

/**
 * Creating an agent is a short conversation: the owner says what the agent should
 * take care of, the builder (the owner's default model, or one picked below) proposes
 * it as a live card, and one click creates it. The conversation runs in a builder
 * thread the server starts; once the agent exists the thread is removed. The page is
 * laid out like an agent's conversation, with the builder pinned at the top; its
 * neutral accent crossfades to the proposed agent's colour as the card assembles.
 * Started from a project (`projectFolderId`), the conversation and the agent it
 * proposes are filed there; the owner can change that before the first message, and
 * on the card before creating.
 */
export function AgentBuilder(props: {
  environmentId?: EnvironmentId;
  projectFolderId?: ProjectLabelId;
}) {
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      <AgentBuilderConversation {...props} />
    </SidebarInset>
  );
}

/**
 * The builder page's content. `resume` opens a builder thread that already exists,
 * such as one an agent started over MCP (`start_agent_builder`): the conversation
 * shows in place, with no empty state to move out of.
 */
export function AgentBuilderConversation({
  environmentId: requested,
  projectFolderId: requestedFolderId,
  resume,
}: {
  environmentId?: EnvironmentId;
  projectFolderId?: ProjectLabelId;
  resume?: BuilderThread & { modelSelection: ModelSelection };
}) {
  const navigate = useNavigate();
  const client = useAgentsClient();
  const { agents, models } = useAgents();
  const shells = useThreadShells();
  const primary = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const projects = useProjects();
  const local = requested ?? primary;
  const fallbackProject = projects.find((project) => project.environmentId === local);
  const scratchEnvironment = scratchEnvironmentId(local);
  const environmentId =
    resume?.environmentId ?? scratchEnvironment ?? fallbackProject?.environmentId ?? null;
  const setSidebarMode = useUiStateStore((store) => store.setSidebarMode);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const builderStart = useOrchestrationCommand(agentsRpc.builderStart, {
    reportFailure: false,
  });
  const deleteThread = useOrchestrationCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const [thread, setThread] = useState<BuilderThread | null>(() =>
    resume
      ? {
          environmentId: resume.environmentId,
          projectId: resume.projectId,
          threadId: resume.threadId,
          projectFolderId: resume.projectFolderId,
        }
      : null,
  );
  const [pending, setPending] = useState<ReadonlyArray<AgentMessage>>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<AgentContact | null>(null);
  // A resumed thread's face stays the same on every open.
  const [seed] = useState(() => resume?.threadId ?? randomUUID());
  const defaultModel = useDefaultAgentModel(environmentId);
  const [chosenModel, setChosenModel] = useState<ModelSelection | null>(
    resume?.modelSelection ?? null,
  );
  const modelSelection = chosenModel ?? defaultModel;
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardFace, setCardFace] = useState<"created" | "idle">("idle");
  // Where the builder is filed when it starts, and the owner's pick on the card.
  const [startFolderId, setStartFolderId] = useState<ProjectLabelId | null>(
    requestedFolderId ?? null,
  );
  const [chosenOwner, setChosenOwner] = useState<EnvironmentId | null>(null);
  const machineQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.machinesLive({ environmentId, input: {} }),
  );
  const ownerMachines = machineQuery.data?.machines ?? [];
  const ownerMachine =
    environmentId === null ? null : defaultAgentOwner(environmentId, ownerMachines);
  const [cardFolderId, setCardFolderId] = useState<ProjectLabelId | null | undefined>(undefined);
  const { folders } = useAgentProjectFolders(thread?.environmentId ?? environmentId, null);
  const folderExists = (id: ProjectLabelId) => folders.some((entry) => entry.label.id === id);
  useEffect(() => setSidebarMode("agents"), [setSidebarMode]);

  const state = useEnvironmentThread(thread?.environmentId ?? null, thread?.threadId ?? null);
  const projection = Option.getOrNull(state.data);
  const messages = useMemo<ReadonlyArray<AgentMessage>>(() => {
    const persisted: AgentMessage[] = (projection?.messages ?? [])
      .filter((message) => message.role !== "system" && message.text.trim())
      .map((message) => ({
        id: message.id,
        role: message.role as AgentMessage["role"],
        text: message.text,
        createdAt: DateTime.formatIso(message.createdAt),
        streaming: message.streaming,
      }));
    const ids = new Set(persisted.map((row) => row.id));
    // The first message's id is server-made, so it never matches the optimistic
    // row's; its text arriving covers it. Later sends reuse their row id.
    const userTexts = new Set(
      persisted.filter((row) => row.role === "user").map((row) => row.text),
    );
    return [...persisted, ...pending.filter((row) => !ids.has(row.id) && !userTexts.has(row.text))];
  }, [projection?.messages, pending]);
  const busy =
    !created && (sending || Boolean(projection?.runs.some((run) => LIVE_RUN.has(run.status))));
  const proposal = useMemo(
    () => proposalFromTurnItems(projection?.turnItems ?? []) ?? proposalFromMessages(messages),
    [projection?.turnItems, messages],
  );
  const workingOn = workingOnFromItems(projection?.turnItems ?? []);
  const modelName = modelSelection ? modelDisplayName(models, modelSelection) : null;
  const accent = proposal?.face?.color ? accentForColor(proposal.face.color) : NEUTRAL_ACCENT;
  const face: AgentFaceProps = proposal?.face
    ? avatarFaceProps({ seed, ...proposal.face })
    : builderFace(seed);
  const name = proposal?.name ?? "New agent";
  // Only a change while mounted moves the person: a new builder mounts empty, so the
  // first render is the empty state at rest. A resumed one already has its
  // conversation (it may still be loading), so it never shows the empty state.
  const [hero, setHero] = useState<HeroPhase>(resume ? "gone" : "shown");
  const empty = messages.length === 0;
  const heroShown = hero === "shown" || hero === "returning";
  if (!resume && !empty && heroShown) setHero("leaving");
  if (!resume && empty && !heroShown) setHero("returning");
  const heroRef = useRef<HTMLDivElement>(null);
  const headerPersonRef = useRef<HTMLDivElement>(null);
  // Every animation of the move and its way back, kept across phases: a send that
  // fails mid-move returns from wherever the move got to.
  const heroMotion = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    if (hero === "shown") {
      // The header's person is hidden again; drop what the way back left on it.
      for (const animation of heroMotion.current) animation.cancel();
      heroMotion.current = [];
    }
    if (hero !== "leaving" && hero !== "returning") return;
    const layer = heroRef.current;
    const person = headerPersonRef.current;
    let animations: Animation[] = [];
    if (hero === "leaving") {
      animations = layer && person ? playHeroMove(layer, person) : [];
      heroMotion.current = animations;
    } else {
      // The empty state fades back in as a whole over its own half-faded copy, and
      // the header's person fades out where it is, even mid-move.
      for (const animation of heroMotion.current) {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        if (layer && target && layer.contains(target)) animation.cancel();
      }
      animations = [fadeOut(person), fadeIn(layer)].filter((animation) => animation !== undefined);
      heroMotion.current = [...heroMotion.current, ...animations];
    }
    let current = true;
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => current && setHero(hero === "returning" ? "shown" : "gone"),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [hero]);
  useEffect(
    () => () => {
      for (const animation of heroMotion.current) animation.cancel();
    },
    [],
  );
  const proposalFolderId = proposalProjectFolderId({
    chosen: cardFolderId,
    proposed: proposal?.projectFolderId,
    builder: thread?.projectFolderId ?? null,
    exists: folderExists,
  });
  // Only a folder still on the machine files the builder.
  const startFolder = startFolderId !== null && folderExists(startFolderId) ? startFolderId : null;

  const send = useCallback(
    async (text: string) => {
      if (!environmentId || !modelSelection || sending) return;
      setSending(true);
      setError(null);
      const messageId = newMessageId();
      setPending((current) => [
        ...current,
        {
          id: messageId,
          role: "user",
          text,
          createdAt: new Date().toISOString(),
          optimistic: true,
        },
      ]);
      try {
        if (thread === null) {
          const project =
            scratchEnvironment === null
              ? fallbackProject
              : await openScratchProject(environmentId, "Could not start the builder");
          if (!project) throw new Error("This machine can't start a conversation right now.");
          const result = await builderStart({
            environmentId,
            input: {
              projectId: project.id,
              modelSelection,
              text,
              ...(startFolder ? { projectFolderId: startFolder } : {}),
            },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          setThread({
            environmentId,
            projectId: result.value.projectId,
            threadId: result.value.threadId,
            projectFolderId: startFolder,
          });
          return;
        }
        const result = await startTurn({
          environmentId: thread.environmentId,
          input: {
            threadId: thread.threadId,
            message: { messageId, role: "user", text, attachments: [] },
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      } catch (cause) {
        setPending((current) => current.filter((row) => row.id !== messageId));
        setError(cause instanceof Error ? cause.message : "Could not send.");
      } finally {
        setSending(false);
      }
    },
    [
      builderStart,
      environmentId,
      modelSelection,
      openScratchProject,
      scratchEnvironment,
      fallbackProject,
      sending,
      startFolder,
      startTurn,
      thread,
    ],
  );

  const create = useCallback(async () => {
    if (!thread || !modelSelection || !canCreateProposal(proposal) || creating) return;
    setCreating(true);
    setError(null);
    const [first, ...rest] = proposalTriggers(proposal);
    try {
      const draft = {
        ...proposalToDraft(proposal, {
          seed,
          modelSelection,
          projectId: thread.projectId,
          projectFolderId: proposalFolderId,
        }),
        kickoff: true,
      };
      const machine = chosenOwner ?? proposal.machine ?? ownerMachine;
      if (machine === null) return;
      const contact = await client.save(
        thread.environmentId,
        { ...draft, ownerMachine: machine },
        first,
      );
      await finish(contact, rest);
    } catch (cause) {
      if (cause instanceof AgentCreatedWithoutTriggerError) {
        toastManager.add({
          type: "warning",
          title: `${cause.agent.name} was created, but its schedule didn't save`,
          description: "Add it under Details, or ask the agent in its chat.",
        });
        await finish(cause.agent, rest);
        return;
      }
      setCreating(false);
      setError(cause instanceof Error ? cause.message : "Could not create the agent.");
    }
    async function finish(contact: AgentContact, more: typeof rest) {
      for (const trigger of more) {
        await client.saveTrigger(contact, trigger).catch((cause: unknown) =>
          toastManager.add({
            type: "warning",
            title: `Could not save “${trigger.title}”`,
            description: cause instanceof Error ? cause.message : "Add it under Details.",
          }),
        );
      }
      noteAgentArrival(agentContactKey(contact));
      await flyToAgentsList(cardRef.current);
      // The server opens the agent's own first turn; nothing visible to send.
      setCreated(contact);
    }
  }, [
    chosenOwner,
    ownerMachine,
    client,
    creating,
    modelSelection,
    proposal,
    proposalFolderId,
    seed,
    thread,
  ]);

  // The save returns before the live lists carry the agent; wait so the route can't
  // mistake the conversation for a missing thread, then leave and drop the builder thread.
  useEffect(() => {
    if (
      !created ||
      !agents.some(
        (agent) => agent.environmentId === created.environmentId && agent.id === created.id,
      ) ||
      !shells.some(
        (shell) =>
          shell.environmentId === created.environmentId &&
          shell.id === created.conversationThreadId,
      )
    )
      return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: created.environmentId, threadId: created.conversationThreadId },
      replace: true,
    });
    if (thread)
      void deleteThread({
        environmentId: thread.environmentId,
        input: { threadId: thread.threadId },
      });
  }, [agents, created, deleteThread, navigate, shells, thread]);

  const cancel = () => {
    if (thread && !created)
      void deleteThread({
        environmentId: thread.environmentId,
        input: { threadId: thread.threadId },
      });
    void navigate({ to: "/" });
  };

  return (
    <section className="agent-conversation" aria-label="New agent" style={accentStyle(accent)}>
      <AgentIdentity
        face={face}
        name={name}
        person={
          <AgentIdentityPerson
            ref={headerPersonRef}
            // Plays the card face's entrance along with it, so the two read as one agent.
            face={{
              ...face,
              state: cardFace === "created" ? "created" : busy ? "thinking" : "idle",
            }}
            name={name}
            // Held until the move lands, so the pill arrives the size it left.
            status={busy && hero === "gone" ? "Thinking…" : null}
            hidden={hero === "shown"}
            morphName
          />
        }
        trailing={
          <Button size="icon-sm" variant="ghost-muted" aria-label="Cancel" onClick={cancel}>
            <XIcon className="size-4.5" />
          </Button>
        }
      />
      <Transcript
        threadKey={thread?.threadId ?? "builder"}
        messages={messages}
        busy={busy}
        workingOn={workingOn}
        seed={seed}
        proposal={proposal}
        modelName={modelName}
        owner={{
          machines: ownerMachines,
          value: chosenOwner ?? proposal?.machine ?? ownerMachine,
          onChange: setChosenOwner,
        }}
        project={
          // Nothing to pick on a machine without projects.
          thread && folders.length > 0
            ? {
                environmentId: thread.environmentId,
                value: proposalFolderId,
                onChange: setCardFolderId,
              }
            : null
        }
        creating={creating}
        cardRef={cardRef}
        onCreate={() => void create()}
        onCardFace={setCardFace}
        overlay={
          hero === "gone" ? null : (
            <Hero
              ref={heroRef}
              face={face}
              name={name}
              leaving={hero === "leaving"}
              onExample={(text) => void send(text)}
            />
          )
        }
      >
        <footer className="agent-composer-area">
          {error && (
            <p role="alert" className="agent-error">
              {error}
            </p>
          )}
          {environmentId === null ? (
            <p className="agent-conversation-empty">
              Open a repository to create an agent.
              <span>
                The builder uses a repository when this machine has no No project workspace.
              </span>
            </p>
          ) : (
            <BuilderComposer
              environmentId={environmentId}
              modelSelection={modelSelection}
              onModelChange={setChosenModel}
              // Filing is picked before the conversation starts; the card takes over after.
              project={
                thread === null
                  ? { value: startFolder, onChange: setStartFolderId, shown: folders.length > 0 }
                  : null
              }
              placeholder={
                thread
                  ? "Adjust anything, or ask for something else"
                  : "What should this agent take care of?"
              }
              disabled={!modelSelection || creating || created !== null}
              sending={sending}
              onSend={send}
            />
          )}
        </footer>
      </Transcript>
    </section>
  );
}

function Transcript({
  threadKey,
  messages,
  busy,
  workingOn,
  seed,
  proposal,
  modelName,
  owner,
  project,
  creating,
  cardRef,
  onCreate,
  onCardFace,
  overlay,
  children,
}: {
  threadKey: string;
  messages: ReadonlyArray<AgentMessage>;
  busy: boolean;
  workingOn: string | null;
  seed: string;
  proposal: ReturnType<typeof proposalFromMessages>;
  modelName: string | null;
  owner: ComponentProps<typeof AgentProposalCard>["owner"];
  project: ComponentProps<typeof AgentProposalCard>["project"];
  creating: boolean;
  cardRef: RefObject<HTMLDivElement | null>;
  onCreate: () => void;
  onCardFace: (state: "created" | "idle") => void;
  /** The empty state, drawn over the transcript. */
  overlay: ReactNode;
  /** The composer, under the transcript. */
  children: ReactNode;
}) {
  // The typing bubble follows a send by a beat, as a reply would.
  const [typingBusy, setTypingBusy] = useState(false);
  useEffect(() => {
    if (!busy) {
      setTypingBusy(false);
      return;
    }
    const timer = setTimeout(() => setTypingBusy(true), 150);
    return () => clearTimeout(timer);
  }, [busy]);
  // The reply that arrives takes over the typing bubble's element (see stepTypingSlot).
  const typingSlot = useRef<TypingSlotState>(INITIAL_TYPING_SLOT);
  const { typingKey, claimed } = useMemo(() => {
    const step = stepTypingSlot(typingSlot.current, messages, busy && typingBusy);
    typingSlot.current = step.state;
    return { typingKey: step.typingKey, claimed: step.state.claimed };
  }, [messages, busy, typingBusy]);
  const keep = useMemo(() => new Set(claimed.keys()), [claimed]);
  const conversation = useMemo(
    () => ({ key: threadKey, messages, requests: [], hasMoreMessages: false }),
    [threadKey, messages],
  );
  const { scroll, onScroll, stopFollowing } = useMessageMotion(conversation, busy, typingKey, {
    keep,
  });
  const latestAssistant = messages.findLast((message) => message.role === "assistant");
  return (
    <>
      <div className="agent-builder-stage">
        <div
          ref={scroll}
          className="agent-message-scroll scroll-fade-y"
          onScroll={onScroll}
          onWheel={stopFollowing}
          onTouchStart={stopFollowing}
        >
          <div
            className="agent-messages"
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {conversationRows(messages).map(({ message, separator, grouped }) => {
              const text = message.role === "user" ? message.text : stripProposal(message.text);
              return (
                <Fragment key={claimed.get(message.id) ?? message.id}>
                  <div
                    data-message-id={message.id}
                    className="agent-message-row"
                    data-owner={message.role === "user"}
                    data-grouped={grouped}
                  >
                    {separator && (
                      <div className="agent-separator">
                        <time dateTime={message.createdAt}>{separator}</time>
                      </div>
                    )}
                    {text && (
                      <div
                        className="agent-bubble"
                        data-owner={message.role === "user"}
                        data-streaming={message.streaming || undefined}
                      >
                        {message.role === "assistant" ? (
                          <div className="agent-markdown">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                          </div>
                        ) : (
                          text
                        )}
                      </div>
                    )}
                    {message.id === latestAssistant?.id && proposal && (
                      <div className={cn("w-full", text && "mt-2")}>
                        <AgentProposalCard
                          ref={cardRef}
                          proposal={proposal}
                          seed={seed}
                          modelName={modelName}
                          owner={owner}
                          project={project}
                          creating={creating}
                          onCreate={onCreate}
                          onFaceChange={onCardFace}
                        />
                      </div>
                    )}
                  </div>
                </Fragment>
              );
            })}
            {typingKey && (
              <div
                key={typingKey}
                data-message-id={typingKey}
                className="agent-message-row"
                data-owner={false}
                data-grouped={messages.at(-1)?.role === "assistant"}
              >
                <div className="agent-bubble" data-owner={false}>
                  <AgentTypingDots />
                </div>
                {workingOn && (
                  <span key={workingOn} className="agent-typing-hint agent-morph">
                    {workingOn}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        {overlay}
      </div>
      {children}
    </>
  );
}

/**
 * The empty state: the agent about to be made, then what to say. A first render
 * is at rest; only an empty state that comes back (a first send that failed)
 * fades in, which the builder plays on it.
 */
function Hero({
  ref,
  face,
  name,
  leaving,
  onExample,
}: {
  ref: Ref<HTMLDivElement>;
  face: AgentFaceProps;
  name: string;
  leaving: boolean;
  onExample: (text: string) => void;
}) {
  return (
    <div
      ref={ref}
      className="agent-builder-hero"
      data-leaving={leaving || undefined}
      inert={leaving}
    >
      <div className="m-auto flex w-full flex-col items-center gap-5">
        <AgentIdentityPerson face={face} name={name} size="hero" morphName />
        <div data-hero-copy className="agent-conversation-empty w-full gap-3">
          <span className="text-base text-foreground">Tell me what to take care of.</span>
          <span>
            Describe the job in a sentence. I'll pick a face, a name and a schedule; change anything
            by just saying so.
          </span>
          <ul className="mt-2 flex flex-wrap justify-center gap-1.5" aria-label="Examples">
            {BUILDER_EXAMPLES.map((example) => (
              <li key={example} className="grid max-w-full">
                <Button
                  variant="outline"
                  size="xs"
                  className="min-w-0"
                  title={example}
                  onClick={() => onExample(example)}
                >
                  <span className="truncate">{example}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

const STANDARD_EASING_FALLBACK = "cubic-bezier(0.32, 0.72, 0, 1)";

function fade(element: Element | null, keyframes: Keyframe[], fill: FillMode) {
  if (!element || typeof element.animate !== "function") return undefined;
  return element.animate(keyframes, {
    duration: Number.parseFloat(motionToken("--motion-duration-fast", "150")),
    easing: motionToken("--motion-ease-standard", STANDARD_EASING_FALLBACK),
    fill,
  });
}

/** A short opacity fade out that holds, for something about to be hidden or removed. */
const fadeOut = (element: Element | null) =>
  fade(element, [{ opacity: 1 }, { opacity: 0 }], "forwards");
const fadeIn = (element: Element | null) => fade(element, [{ opacity: 0 }, { opacity: 1 }], "none");

/**
 * The empty state's person moves into the header as one element: the header's
 * person, already in its final place, is drawn from where the hero's is and
 * glides up while the copy fades. Under reduced motion the hero fades out and
 * the header's person fades in. Returns the running animations.
 */
function playHeroMove(hero: HTMLElement, header: HTMLElement): Animation[] {
  if (typeof hero.animate !== "function") return [];
  const easing = motionToken("--motion-ease-standard", STANDARD_EASING_FALLBACK);
  const from = hero.querySelector<HTMLElement>(".agent-identity-person");
  const animations = [fadeOut(hero.querySelector("[data-hero-copy]"))];
  if (!from || prefersReducedMotion()) {
    animations.push(fadeOut(from), fadeIn(header));
    return animations.filter((animation) => animation !== undefined);
  }
  const move = {
    duration: Number.parseFloat(motionToken("--motion-duration-panel", "300")),
    easing,
  };
  // The header's person is the one that moves; the hero's steps aside for it.
  animations.push(
    from.animate([{ opacity: 0 }, { opacity: 0 }], { duration: move.duration, fill: "forwards" }),
  );
  // The face and the pill each scale by their own ratio, so both land exactly.
  for (const part of [".agent-identity-face", ".agent-identity-name"]) {
    const start = from.querySelector(part)?.getBoundingClientRect();
    const target = header.querySelector<HTMLElement>(part);
    const end = target?.getBoundingClientRect();
    if (!start || !target || !end || end.height === 0) continue;
    const dx = start.left + start.width / 2 - (end.left + end.width / 2);
    const dy = start.top + start.height / 2 - (end.top + end.height / 2);
    const scale = start.height / end.height;
    animations.push(
      target.animate(
        [
          { transformOrigin: "50% 50%", transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
          { transformOrigin: "50% 50%", transform: "none" },
        ],
        move,
      ),
    );
  }
  return animations.filter((animation) => animation !== undefined);
}

const MIN_HEIGHT = 78;
const MAX_HEIGHT = 208;
const noop = () => {};

/** The agent composer's card around a plain prompt, with the builder's model picker. */
function BuilderComposer({
  environmentId,
  modelSelection,
  onModelChange,
  project,
  placeholder,
  disabled,
  sending,
  onSend,
}: {
  environmentId: EnvironmentId;
  modelSelection: ModelSelection | null;
  onModelChange: (selection: ModelSelection) => void;
  /** The project the builder starts filed in, until its first message. */
  project: {
    value: ProjectLabelId | null;
    onChange: (projectFolderId: ProjectLabelId | null) => void;
    shown: boolean;
  } | null;
  placeholder: string;
  disabled: boolean;
  sending: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = `${MIN_HEIGHT}px`;
    if (text)
      element.style.height = `${Math.min(Math.max(element.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
  }, [text]);
  const submit = async () => {
    const outgoing = text.trim();
    if (!outgoing || sending || disabled) return;
    setText("");
    await onSend(outgoing);
    textarea.current?.focus();
  };
  return (
    <form
      className="mx-auto w-full min-w-0"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div className="rounded-3xl">
              <div className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4">
                <textarea
                  ref={textarea}
                  autoFocus
                  disabled={disabled}
                  aria-label={placeholder}
                  placeholder={placeholder}
                  rows={1}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing &&
                      !window.matchMedia("(pointer: coarse)").matches
                    ) {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                  className="-m-1 block w-[calc(100%+0.5rem)] resize-none overflow-y-auto bg-transparent p-1 font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) leading-relaxed text-foreground placeholder:text-placeholder/75 focus:outline-none max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)"
                />
              </div>
              <div className="flex min-w-0 flex-nowrap items-center justify-between gap-2 px-3 pb-3 sm:gap-0 sm:px-4 sm:pb-4">
                <div className="scroll-fade-x relative -m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {modelSelection && (
                    <LiveModelControls
                      environmentId={environmentId}
                      selection={modelSelection}
                      disabled={disabled}
                      unavailable={false}
                      pickerOpen={pickerOpen}
                      onPickerOpenChange={setPickerOpen}
                      onChange={onModelChange}
                    />
                  )}
                  {project?.shown ? (
                    <BuilderProjectPicker
                      environmentId={environmentId}
                      value={project.value}
                      disabled={disabled}
                      onChange={project.onChange}
                    />
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-nowrap items-center justify-end gap-1">
                  <ComposerPrimaryActions
                    compact={false}
                    canOperateThread={!disabled}
                    pendingAction={null}
                    isRunning={false}
                    canInterrupt={false}
                    showPlanFollowUpPrompt={false}
                    promptHasText={text.trim().length > 0}
                    isSendBusy={sending}
                    sendDisabledReason={null}
                    isConnecting={false}
                    isEnvironmentUnavailable={disabled}
                    isPreparingWorktree={false}
                    hasSendableContent={text.trim().length > 0}
                    onPreviousPendingQuestion={noop}
                    onInterrupt={noop}
                    onImplementPlanInNewThread={noop}
                  />
                </div>
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </form>
  );
}

/** The composer's project chip: where the builder and the agent it proposes are filed. */
function BuilderProjectPicker(props: {
  environmentId: EnvironmentId;
  value: ProjectLabelId | null;
  disabled: boolean;
  onChange: (projectFolderId: ProjectLabelId | null) => void;
}) {
  const { current } = useAgentProjectFolders(props.environmentId, props.value);
  return (
    <AgentProjectPicker
      environmentId={props.environmentId}
      value={props.value}
      onChange={props.onChange}
      disabled={props.disabled}
      aria-label={current ? `File in ${current.label.name}` : "File in a project"}
      trigger={<ComposerControl collapsible />}
    >
      <ComposerProjectChip project={current} />
    </AgentProjectPicker>
  );
}

/**
 * The created card leaves toward the sidebar's agents list, shrinking as it goes, so the
 * new row there reads as the same thing arriving. Without a visible list (mobile, a
 * collapsed sidebar) or under reduced motion it only fades.
 */
function flyToAgentsList(card: HTMLElement | null): Promise<void> {
  if (!card || typeof card.animate !== "function") return Promise.resolve();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const target = document.querySelector("[data-agents-list]");
  const from = card.getBoundingClientRect();
  const to = target?.getBoundingClientRect();
  const visible = to !== undefined && to.width > 0 && to.height > 0;
  const easing = "cubic-bezier(0.32, 0.72, 0, 1)";
  const animation =
    reduced || !visible
      ? card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing, fill: "forwards" })
      : (() => {
          card.style.transformOrigin = "top left";
          const dx = to.left + 12 - from.left;
          const dy = to.top + 6 - from.top;
          return card.animate(
            [
              { transform: "translate(0, 0) scale(1)", opacity: 1 },
              { transform: `translate(${dx}px, ${dy}px) scale(0.28)`, opacity: 0 },
            ],
            { duration: 220, easing, fill: "forwards" },
          );
        })();
  return animation.finished.then(
    () => undefined,
    () => undefined,
  );
}
