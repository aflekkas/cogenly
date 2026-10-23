import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { LinkIcon, PlusIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";

import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { isElectron } from "../env";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { WorkspacePageTitle } from "../components/WorkspacePageTitle";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { useAgents } from "../agents/agentsClient";
import { requestAgentCreation } from "../agents/AgentsCreateHost";
import { AgentFace } from "../components/agents/face";
import { type ModeLanding } from "../components/sidebar/modes/modeLanding.logic";
import { type SidebarMode } from "../components/sidebar/modes/sidebarModes.logic";
import { computeModeLanding } from "../components/sidebar/modes/useLandOnMode";
import { useSidebarModeClassifier } from "../components/sidebar/modes/useSidebarModeState";
import { environmentServerConfigsAtom } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import {
  readProject,
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();
  const sidebarMode = useUiStateStore((store) => store.sidebarMode);

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedStaticOnboardingState />;
  }

  return <ModeIndexLanding key={sidebarMode} mode={sidebarMode} />;
}

/**
 * Landing on the index route opens what the sidebar's mode lists, so the
 * first screen is never a thread of another kind: Chats opens a chat, Work a
 * draft in the most recently active repository, Agents an agent, Projects
 * the overview. Keyed by mode, so a mode switch on the index lands again.
 */
function ModeIndexLanding({ mode }: { readonly mode: SidebarMode }) {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const { agents, loading: agentsLoading } = useAgents();
  const { classifier } = useSidebarModeClassifier({
    threads,
    projects,
    serverConfigs,
  });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();
  const router = useRouter();
  // Read at effect time: this page stays mounted while a navigation away from
  // "/" is still loading, but the router already points at the new location.
  const isStillOnIndex = useEffectEvent(() => router.state.location.pathname === "/");
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  const landing = useMemo(
    () =>
      computeModeLanding({
        mode,
        threads,
        projects,
        agents,
        agentsLoading,
        bootstrapped,
        classifier,
        chatEnvironmentId: scratchEnvironmentId(primaryEnvironmentId),
      }),
    [
      agents,
      agentsLoading,
      bootstrapped,
      classifier,
      mode,
      primaryEnvironmentId,
      projects,
      scratchEnvironmentId,
      threads,
    ],
  );

  // `attempt` changes on a retry, so the same landing runs again.
  const land = useEffectEvent((landing: ModeLanding, _attempt: number) => {
    // Opening something after the user has left would replace the page they picked.
    if (startingRef.current || !isStillOnIndex()) return;
    switch (landing.kind) {
      case "open-thread":
        startingRef.current = true;
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(landing.threadRef),
          replace: true,
        });
        return;
      case "new-chat":
        startingRef.current = true;
        void startScratchThread(landing.environmentId, { replace: true, surface: "chat" });
        return;
      case "repository-draft": {
        // A repository removed since this render is gone from the store; the
        // next render picks another one.
        if (readProject(landing.projectRef) === null) return;
        startingRef.current = true;
        void handleNewThread(landing.projectRef, { replace: true })
          .then((opened) => {
            // The repository was removed while its draft started; land on the next one.
            if (opened === null) {
              startingRef.current = false;
              setStartState((state) => ({ ...state, retryRequest: state.retryRequest + 1 }));
            }
          })
          .catch(() => {
            startingRef.current = false;
            setStartState((state) => ({ ...state, failed: true }));
          });
        return;
      }
      default:
        return;
    }
  });
  useEffect(() => {
    land(landing, startState.retryRequest);
  }, [landing, startState.retryRequest]);

  switch (landing.kind) {
    case "repository-draft":
      return startState.failed ? (
        <DraftStartError
          onRetry={() => {
            setStartState((state) => ({
              failed: false,
              retryRequest: state.retryRequest + 1,
            }));
          }}
        />
      ) : null;
    // First-run routing to the welcome wizard happens in FirstRunGate at the
    // root, before this route ever renders.
    case "no-repositories":
      return <NoProjectsHero />;
    case "chats-unavailable":
      return (
        <IndexEmptyState
          title="Chats aren’t available here"
          description="This machine can’t start a chat without a repository right now."
        />
      );
    // With no agents the list column is hidden (routeHidesListColumn), so this
    // is the one empty state: mascot, a line of copy and the brand CTA.
    case "agents-empty":
      return (
        <IndexEmptyState
          pageTitle="Agents"
          title="No agents yet"
          description="An agent is a persistent specialist with its own conversation and responsibility."
          media={
            <AgentFace
              seed="new-friend"
              expression="neutre"
              color="currentColor"
              paper="none"
              size={64}
              className="text-foreground/90"
            />
          }
        >
          <Button
            variant="brand"
            size="sm"
            onClick={() => requestAgentCreation(primaryEnvironmentId)}
          >
            <PlusIcon className="size-4" />
            Create your first agent
          </Button>
        </IndexEmptyState>
      );
    default:
      return null;
  }
}

function IndexEmptyState(props: {
  /** Titles the page header where the list column would, when there is none. */
  readonly pageTitle?: string;
  readonly title: string;
  readonly description: string;
  readonly media?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {props.pageTitle ? (
        <WorkspacePageHeader electron={isElectron}>
          <WorkspacePageTitle>
            <h1
              className="min-w-0 flex-1 truncate text-sm font-medium tracking-tight"
              data-panel-flip="start"
            >
              {props.pageTitle}
            </h1>
          </WorkspacePageTitle>
        </WorkspacePageHeader>
      ) : isElectron ? (
        <WorkspacePageHeader electron />
      ) : null}
      <Empty>
        <EmptyHeader>
          {props.media ? <EmptyMedia>{props.media}</EmptyMedia> : null}
          <EmptyTitle>{props.title}</EmptyTitle>
          <EmptyDescription>{props.description}</EmptyDescription>
          {props.children ? <EmptyContent>{props.children}</EmptyContent> : null}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription>
            The repository is still available. Try opening the draft again.
          </EmptyDescription>
          <EmptyContent>
            <Button size="sm" onClick={onRetry}>
              <RefreshIcon size="md" />
              Try again
            </Button>
          </EmptyContent>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  const cloudEnabled = hasCloudPublicConfig();
  const localEnvironmentOff = isLocalEnvironmentDisabled();
  const description = localEnvironmentOff
    ? "The local environment is turned off. Connect a remote environment, or turn the local environment back on in Connections."
    : cloudEnabled
      ? "Enable Cogenly Connect on that machine, then open Connections here to sign in with the same account. You can also add the machine using a pairing link."
      : "Open Connections and add that machine using its pairing link. This app must be able to reach it.";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </WorkspacePageHeader>

        <Empty>
          <EmptyHeader className="max-w-xl">
            <EmptyMedia>
              <LinkIcon />
            </EmptyMedia>
            <EmptyTitle>Connect to a computer running Cogenly</EmptyTitle>
            <EmptyDescription>
              This app connects to Cogenly running on your computer or a server. Start the Cogenly
              desktop app or command-line server on that machine and keep it running.
            </EmptyDescription>
            <EmptyDescription>{description}</EmptyDescription>
            <EmptyContent>
              <Button render={<Link to="/settings/connections" />} size="sm">
                <PlusIcon className="size-4" />
                Open Connections
              </Button>
            </EmptyContent>
          </EmptyHeader>
        </Empty>
      </div>
    </SidebarInset>
  );
}
