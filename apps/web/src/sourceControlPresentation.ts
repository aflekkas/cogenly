import type { ElementType } from "react";
import type { SourceControlProviderInfo } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type {
  ChangeRequestTerminology,
  SourceControlClientDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import { GitHubIcon } from "./components/Icons";
import { PullRequestGlyph } from "~/components/changeRequestIcons";

export type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";

type SourceControlIcon = ElementType<{ className?: string }>;

/** Web art for each definition `icon` key; a key without art draws the change request glyph. */
const SOURCE_CONTROL_ICONS: Partial<Record<string, SourceControlIcon>> = {
  github: GitHubIcon,
};

export function sourceControlIcon(definition: SourceControlClientDefinition): SourceControlIcon {
  return SOURCE_CONTROL_ICONS[definition.icon] ?? PullRequestGlyph.pullRequest;
}

export interface SourceControlPresentation {
  readonly definition: SourceControlClientDefinition;
  readonly providerName: string;
  readonly terminology: ChangeRequestTerminology;
  readonly Icon: SourceControlIcon;
}

function presentDefinition(
  definition: SourceControlClientDefinition,
  providerName: string,
): SourceControlPresentation {
  return {
    definition,
    providerName,
    terminology: definition.changeRequest,
    Icon: sourceControlIcon(definition),
  };
}

/** Named as the server reported the host, e.g. "GitHub Self-Hosted", when it reported one. */
export function getSourceControlPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): SourceControlPresentation {
  const definition = sourceControlClients.get(provider?.kind);
  return presentDefinition(definition, provider?.name || definition.label);
}
