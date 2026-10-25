import { SharedClientPreferencesSync } from "../components/SharedClientPreferencesSync";
import { LiveAgentsProvider } from "../agents/agentsClient";
import { AgentsCreateHost } from "../agents/AgentsCreateHost";
import { CreateProjectDialogHost } from "../projectLabels/CreateProjectDialogHost";
import { PermissionUpdateNotice } from "../components/PermissionUpdateNotice";
import { type ServerLifecycleWelcomePayload } from "@cogenly/contracts";
import { scopedProjectKey, scopeProjectRef } from "@cogenly/client-runtime/environment";
import {
  Outlet,
  Link,
  createRootRoute,
  type ErrorComponentProps,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { APP_BASE_NAME, APP_DISPLAY_NAME, APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppDisplayName } from "../branding.logic";
import { AppErrorScreen } from "../components/AppErrorScreen";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPalette } from "../components/CommandPalette";
import { CustomSnoozeDialogHost } from "../components/CustomSnoozeDialog";
import { LaunchMachineDialog } from "../machines/LaunchMachineDialog";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { KeybindingsConfigWarning } from "../components/KeybindingsConfigWarning";
import { FirstRunGate } from "../components/onboarding/FirstRunGate";
import { ConnectOnboardingDialog } from "../components/cloud/ConnectOnboardingDialog";
import { RelayClientInstallDialog } from "../components/cloud/RelayClientInstallDialog";
import { SshPasswordPromptDialog } from "../components/desktop/SshPasswordPromptDialog";
import { DesktopAppActivationCoordinator } from "../components/desktop/DesktopAppActivationCoordinator";
import { DesktopWebLinkCoordinator } from "../components/desktop/DesktopWebLinkCoordinator";
import { RunningThreadKeepAlive } from "../components/desktop/RunningThreadKeepAlive";
import { DesktopUpdateLaunchNotice } from "../components/sidebar/updateEverythingRun";
import { LegacyThreadMigrationToast } from "../components/LegacyThreadMigrationToast";
import { ThreadNotificationCoordinator } from "../components/ThreadNotificationCoordinator";
import { MachineHealthAlertCoordinator } from "../components/MachineHealthAlertCoordinator";
import { ThreadReadCoordinator } from "../components/ThreadReadCoordinator";
import { ReopenClosedViewShortcut } from "../components/ReopenClosedViewShortcut";
import { ProjectCloneToastCoordinator } from "../components/ProjectCloneToastCoordinator";
import { PendingProjectFolderCoordinator } from "../projectLabels/PendingProjectFolderCoordinator";
import { SlowRpcRequestToastCoordinator } from "../components/SlowRpcRequestToastCoordinator";
import { ChatGptWelcomeCoordinator } from "../components/settings/ChatGptWelcomeCoordinator";
import { ProviderAuthCallbackCoordinator } from "../components/settings/ProviderAuthCallbackCoordinator";
import { Button } from "../components/ui/button";
import { stackedThreadToast, ToastProvider, toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import { useClientSettings } from "../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { useUiStateStore } from "../uiStateStore";
import { useTheme, syncBrowserChromeTheme } from "../hooks/useTheme";
import { configureClientTracing } from "../observability/clientTracing";
import { resolveInitialServerAuthGateState } from "../environments/primary";
import { hasHostedPairingRequest, isHostedStaticApp } from "../hostedPairing";
import { useHostedPromptLinkLanding } from "../components/promptLinks/HostedPromptLinkLanding";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { useAtomValue } from "@effect/atom-react";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import {
  primaryServerConfigAtom,
  primaryServerConfigEventAtom,
  primaryServerWelcomeAtom,
} from "../state/server";
import { readProject, setActiveEnvironmentId, useActiveEnvironmentId } from "../state/entities";
import {
  createKeybindingsUpdateToastController,
  type KeybindingsUpdateToastController,
} from "../components/KeybindingsUpdateToast.logic";

import { installDesktopPasteAsText } from "../lib/desktopPasteAsText";

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/pair" && hasHostedPairingRequest(new URL(window.location.href))) {
      return {
        authGateState: {
          status: "hosted-pairing",
        } as const,
      };
    }

    if (isLocalEnvironmentDisabled() || isHostedStaticApp(new URL(window.location.href))) {
      return {
        authGateState: {
          status: "hosted-static",
        } as const,
      };
    }

    const authGateState = await resolveInitialServerAuthGateState();
    return {
      authGateState,
    };
  },
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  notFoundComponent: RootRouteNotFoundView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteNotFoundView() {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-lg font-medium text-foreground">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          This link doesn't point to a page in {APP_DISPLAY_NAME}. Go home to choose a project or
          start a thread.
        </p>
        <Button render={<Link to="/" replace />}>Go home</Button>
      </div>
    </main>
  );
}

function RootRouteView() {
  useEffect(() => installDesktopPasteAsText(window.desktopBridge, window), []);
  const pathname = useLocation({ select: (location) => location.pathname });
  const { authGateState } = Route.useRouteContext();
  const primaryEnvironmentAuthenticated = authGateState.status === "authenticated";
  const returningFromWelcomeRef = useRef(pathname === "/welcome");
  const hostedPromptLinkLanding = useHostedPromptLinkLanding(
    authGateState.status === "hosted-static",
  );

  useEffect(() => {
    if (pathname === "/welcome") {
      returningFromWelcomeRef.current = true;
    }
  }, [pathname]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      syncBrowserChromeTheme();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [pathname]);

  if (pathname === "/pair" || pathname === "/connect" || pathname === "/connect-agent") {
    return (
      <>
        <DocumentTitleSync />
        <Outlet />
      </>
    );
  }

  // Ahead of first-run onboarding, which would otherwise send a new visitor to the welcome
  // wizard and lose the link.
  if (hostedPromptLinkLanding !== null) {
    return (
      <>
        <DocumentTitleSync />
        {hostedPromptLinkLanding}
      </>
    );
  }

  // Show onboarding over the workspace, keeping automatic thread navigation
  // and other startup dialogs suspended until setup finishes.
  if (pathname === "/welcome") {
    return (
      <ToastProvider>
        <DocumentTitleSync />
        <ContrastAppearanceSync />

        <ProviderAuthCallbackCoordinator />
        <CustomSnoozeDialogHost />
        <CommandPalette>
          <AppSidebarLayout>
            <Outlet />
          </AppSidebarLayout>
        </CommandPalette>
      </ToastProvider>
    );
  }

  if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
    return (
      <>
        <DocumentTitleSync />
        <Outlet />
      </>
    );
  }

  const appShell = (
    <CommandPalette>
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    </CommandPalette>
  );

  // FirstRunGate holds back everything below it — including EventRouter,
  // whose welcome payload navigates into a thread — until the first-run
  // decision is known, so a fresh install renders nothing (not the shell,
  // not a flash of threads) before landing on the welcome wizard.
  return (
    <ToastProvider>
      <DocumentTitleSync />
      <ContrastAppearanceSync />

      <ProviderAuthCallbackCoordinator />
      <ChatGptWelcomeCoordinator />
      <SharedClientPreferencesSync />
      <FirstRunGate
        enabled={primaryEnvironmentAuthenticated}
        hostedStatic={authGateState.status === "hosted-static"}
      >
        {primaryEnvironmentAuthenticated ? <AuthenticatedTracingBootstrap /> : null}
        {primaryEnvironmentAuthenticated ? <DesktopAppActivationCoordinator /> : null}
        {primaryEnvironmentAuthenticated ? <DesktopWebLinkCoordinator /> : null}
        {isElectron ? <RunningThreadKeepAlive /> : null}
        <RelayClientInstallDialog />
        <ConnectOnboardingDialog />
        <SshPasswordPromptDialog />
        <ThreadNotificationCoordinator />
        <MachineHealthAlertCoordinator />
        <ThreadReadCoordinator />
        <ReopenClosedViewShortcut />
        <ConfirmDialogHost />
        <LaunchMachineDialog />
        <CustomSnoozeDialogHost />
        <SlowRpcRequestToastCoordinator />
        <PermissionUpdateNotice />
        {primaryEnvironmentAuthenticated ? <LegacyThreadMigrationToast /> : null}
        <ProjectCloneToastCoordinator />
        <PendingProjectFolderCoordinator />
        <HostedStaticEnvironmentBootstrap />
        {primaryEnvironmentAuthenticated ? (
          <EventRouter skipInitialBootstrapNavigation={returningFromWelcomeRef.current} />
        ) : null}
        {isElectron ? <DesktopUpdateLaunchNotice /> : null}
        <LiveAgentsProvider>
          {appShell}
          <AgentsCreateHost />
          <CreateProjectDialogHost />
        </LiveAgentsProvider>
        {/* Above the router: a theme draft is judged by walking the app, so the
              editor has to survive navigation away from settings. */}
      </FirstRunGate>
    </ToastProvider>
  );
}

/** Follows the palette the primary environment's machine publishes, if any. */
function ContrastAppearanceSync() {
  useTheme();
  const diffColorScheme = useClientSettings((settings) => settings.diffColorScheme);

  useEffect(() => {
    document.documentElement.dataset.diffColorScheme = diffColorScheme;
  }, [diffColorScheme]);

  const chatWidth = useClientSettings((settings) => settings.chatWidth);
  useEffect(() => {
    document.documentElement.dataset.chatWidth = chatWidth;
  }, [chatWidth]);

  return null;
}

function DocumentTitleSync() {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;
  const title = resolveServerBackedAppDisplayName({
    baseName: APP_BASE_NAME,
    fallbackDisplayName: APP_DISPLAY_NAME,
    fallbackStageLabel: APP_STAGE_LABEL,
    primaryServerVersion,
  });

  useEffect(() => {
    document.title = title;
  }, [title]);

  return null;
}

function HostedStaticEnvironmentBootstrap() {
  const { environments } = useEnvironments();
  const activeEnvironmentId = useActiveEnvironmentId();

  useEffect(() => {
    if (
      environments.some(
        (environment) => environment.entry.target._tag === "PrimaryConnectionTarget",
      )
    ) {
      return;
    }

    if (activeEnvironmentId) {
      return;
    }

    const firstSavedEnvironment = environments[0];
    if (!firstSavedEnvironment) {
      return;
    }

    setActiveEnvironmentId(firstSavedEnvironment.environmentId);
  }, [activeEnvironmentId, environments]);

  return null;
}

function RootRouteErrorView({ error }: ErrorComponentProps) {
  const router = useRouter();
  // Router pathname rather than window.location: desktop uses hash history, where the window path is always "/".
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <AppErrorScreen error={error} pathname={pathname} onRetry={() => void router.invalidate()} />
  );
}

function AuthenticatedTracingBootstrap() {
  useEffect(() => {
    void configureClientTracing();
  }, []);

  return null;
}

function EventRouter({
  skipInitialBootstrapNavigation,
}: {
  readonly skipInitialBootstrapNavigation: boolean;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironment = usePrimaryEnvironment();
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const serverConfigEvent = useAtomValue(primaryServerConfigEventAtom);
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const skipInitialBootstrapNavigationRef = useRef(skipInitialBootstrapNavigation);
  const handledConfigEventRef = useRef(serverConfigEvent);
  const [keybindingsToastController] = useState<KeybindingsUpdateToastController>(() =>
    createKeybindingsUpdateToastController({}),
  );

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    setActiveEnvironmentId(payload.environment.environmentId);
    void (async () => {
      if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
        return;
      }
      const bootstrapProject = readProject(
        scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
      );
      const bootstrapProjectKey =
        (bootstrapProject
          ? deriveLogicalProjectKeyFromSettings(bootstrapProject, projectGroupingSettings)
          : null) ??
        (serverConfig?.cwd
          ? derivePhysicalProjectKeyFromPath(payload.environment.environmentId, serverConfig.cwd)
          : null) ??
        scopedProjectKey(
          scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
        );
      useUiStateStore.getState().setProjectExpanded(bootstrapProjectKey, true);

      if (readPathname() !== "/") {
        return;
      }
      if (skipInitialBootstrapNavigationRef.current) {
        skipInitialBootstrapNavigationRef.current = false;
        handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
        return;
      }
      if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: payload.environment.environmentId,
          threadId: payload.bootstrapThreadId,
        },
        replace: true,
      });
      handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
    })().catch(() => undefined);
  });

  const handleServerConfigUpdated = useEffectEvent(() => {
    const decision = keybindingsToastController.handle(serverConfigEvent);
    if (!decision) {
      return;
    }

    if (decision._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Keybindings updated",
        description: "Keybindings configuration reloaded successfully.",
      });
      return;
    }

    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: <KeybindingsConfigWarning message={decision.message} />,
      }),
    );
  });

  useEffect(() => {
    if (!serverConfig) {
      return;
    }

    setActiveEnvironmentId(serverConfig.environment.environmentId);
  }, [serverConfig]);

  useEffect(() => {
    handleWelcome(serverWelcome);
  }, [serverWelcome]);

  useEffect(() => {
    if (serverConfigEvent === null || handledConfigEventRef.current === serverConfigEvent) {
      return;
    }
    handledConfigEventRef.current = serverConfigEvent;
    handleServerConfigUpdated();
  }, [serverConfigEvent]);

  return null;
}
