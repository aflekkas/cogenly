import { SourceControlProviderKind } from "@t3tools/contracts";
import type { RepositoryIdentity, SourceControlProviderInfo } from "@t3tools/contracts";

export interface ChangeRequestPresentation {
  readonly icon: "github" | "change-request";
  readonly providerName: string;
  readonly shortName: string;
  readonly longName: string;
  readonly pluralLongName: string;
  readonly providerLongName: string;
  readonly checkoutCommandExample?: string;
  readonly urlExample: string;
}

export interface ChangeRequestTerminology {
  readonly shortLabel: string;
  readonly singular: string;
}

const GITHUB_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "github",
  providerName: "GitHub",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "GitHub pull request",
  checkoutCommandExample: "gh pr checkout 123",
  urlExample: "https://github.com/owner/repo/pull/42",
};

const GENERIC_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "change-request",
  providerName: "source control",
  shortName: "change request",
  longName: "change request",
  pluralLongName: "change requests",
  providerLongName: "change request",
  urlExample: "#42",
};

export function resolveChangeRequestPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestPresentation {
  switch (provider?.kind) {
    case "github":
    case undefined:
      return GITHUB_CHANGE_REQUEST_PRESENTATION;
    default:
      return GENERIC_CHANGE_REQUEST_PRESENTATION;
  }
}

function resolveChangeRequestPresentationForKind(
  kind: SourceControlProviderKind,
): ChangeRequestPresentation {
  return resolveChangeRequestPresentation({ kind, name: "", baseUrl: "" });
}

export function getChangeRequestTerminologyForKind(
  kind: SourceControlProviderKind,
): ChangeRequestTerminology {
  const presentation = resolveChangeRequestPresentationForKind(kind);
  return {
    shortLabel: presentation.shortName,
    singular: presentation.longName,
  };
}

const SCP_SSH_REMOTE_PATTERN = /^[a-zA-Z0-9._-]+@([^:/]+):/;

export function isSshRemoteUrl(remoteUrl: string): boolean {
  const trimmed = remoteUrl.trim();
  return SCP_SSH_REMOTE_PATTERN.test(trimmed) || trimmed.toLowerCase().startsWith("ssh://");
}

/**
 * Extracts the normalized host used for provider detection. SCP-style and SSH remotes return the
 * hostname only, while other URL schemes retain explicit ports for non-default web endpoints.
 */
function parseRemoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const scpMatch = SCP_SSH_REMOTE_PATTERN.exec(trimmed);
  if (scpMatch?.[1]) {
    return scpMatch[1].toLowerCase();
  }

  try {
    const url = new URL(trimmed);
    return (url.protocol === "ssh:" ? url.hostname : url.host).toLowerCase();
  } catch {
    return null;
  }
}

function parseHostName(host: string): string {
  try {
    return new URL(`https://${host}`).hostname.toLowerCase();
  } catch {
    return host.replace(/:\d+$/u, "").toLowerCase();
  }
}

function toBaseUrl(host: string): string {
  return `https://${host}`;
}

function hasDnsLabel(host: string, label: string): boolean {
  return host.split(".").includes(label);
}

function isGitHubHost(host: string): boolean {
  return host === "github.com" || hasDnsLabel(host, "github");
}

export function detectSourceControlProviderFromRemoteUrl(
  remoteUrl: string,
): SourceControlProviderInfo | null {
  const host = parseRemoteHost(remoteUrl);
  if (!host) {
    return null;
  }
  const hostname = parseHostName(host);

  if (isGitHubHost(hostname)) {
    return {
      kind: SourceControlProviderKind.make("github"),
      name: hostname === "github.com" ? "GitHub" : "GitHub Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  return {
    kind: SourceControlProviderKind.make("unknown"),
    name: host,
    baseUrl: toBaseUrl(host),
  };
}

/**
 * The provider-native repository selector. `displayName` is the full path below the host, which
 * is what nested GitLab groups need; owner/name is the two-segment fallback for identities
 * recorded before that field existed.
 *
 * Azure DevOps is the exception: `az repos pr list --repository` takes a repository name, and
 * takes the organisation and project from the checkout it detects — so the recorded
 * `org/project/_git/repo` path is refused outright and the whole repository reads as
 * unavailable. Its name is the last segment, which is what this hands over.
 *
 * One function because everything downstream is keyed by what it answers: the rows' own
 * `repository`, the per-repository cursors, and the detail and diff reads a row leads to.
 */
export function sourceControlRepositorySelector(
  identity:
    | Pick<RepositoryIdentity, "provider" | "displayName" | "owner" | "name">
    | null
    | undefined,
): string | null {
  if (!identity) return null;
  if (identity.displayName) return identity.displayName;
  return identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
}

export function canonicalRepositoryKey(key: string): string {
  return key
    .replace(
      /^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    )
    .replace(
      /^([^.]+)\.visualstudio\.com\/(?:defaultcollection\/)?([^/]+)\/_git\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    );
}
