// Ported from T3 Code (MIT, https://github.com/pingdotgg/t3code),
// apps/web/src/components/chat/ThreadRelationshipIcon.tsx.
import type { ProviderDriverKind, ServerProvider } from "@cogenly/contracts";
import { BotIcon, type LucideIcon } from "lucide-react";

import type { RemoteMachine } from "~/machines/machineBadge.logic";
import { MachineBadge } from "../MachineBadge";
import { BadgeDot, type BadgeDotTone } from "../ui/badge-dot";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

/**
 * A related thread's icon in thread details: the agent's provider glyph (or a
 * fallback for parents, forks and agentless rows) with a small status dot in
 * its bottom-right corner and, for an agent on another machine, a cloud in its
 * top-left. The dot crossfades as the agent's status changes.
 */
export function ThreadRelationshipIcon({
  driver,
  provider,
  tone,
  accentColor,
  remoteMachine = null,
  fallbackIcon: FallbackIcon = BotIcon,
}: {
  driver?: ProviderDriverKind | null | undefined;
  provider?: ServerProvider | undefined;
  tone: BadgeDotTone | null;
  accentColor?: string | undefined;
  remoteMachine?: RemoteMachine | null;
  fallbackIcon?: LucideIcon;
}) {
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={provider?.displayName ?? driver}
          accentColor={accentColor}
          showBadge={accentColor !== undefined}
          size="md"
          iconClassName={THREAD_DETAILS_PANEL_ICON_CLASS}
          className="z-auto"
        />
      ) : (
        <FallbackIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      )}
      <MachineBadge placement="corner" surface="popover" machine={remoteMachine} />
      <BadgeDot tone={tone} ring="popover" className="absolute -right-0.75 -bottom-0.75" />
    </span>
  );
}
