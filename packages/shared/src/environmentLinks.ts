import { sanitizeLinkedPrompt, type PromptLinkResult } from "./promptLinks.ts";

/**
 * Adding a remote environment without clicking through Settings. Three entry points share
 * this request: the `cogenly://environments/add?ssh=<alias>&name=<name>` deep link, the
 * `cogenly environment add` CLI command, and the `t3_environment_add` MCP tool. Each one
 * runs the desktop's SSH flow for an alias the user's SSH config already knows.
 *
 * A deep link can come from any web page, so the desktop confirms it first. The CLI and the
 * MCP tool reach the desktop through its local control socket, which only the same user can
 * open, so they need no confirmation.
 */
export interface AddEnvironmentRequest {
  /** An SSH destination: a config alias or `user@host`. */
  readonly ssh: string;
  /** The display name to save; null picks one from the host (see `defaultSshEnvironmentName`). */
  readonly name: string | null;
}

export const ENVIRONMENT_NAME_MAX_LENGTH = 64;

// A config alias or `user@host`. Never starts with `-`, so it cannot pass for an ssh option,
// and holds nothing a shell or ssh_config token would treat specially.
const SSH_DESTINATION = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/;

/** Checks an SSH destination from a link, flag, or tool call. */
export function parseSshDestination(value: string): PromptLinkResult<string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, error: "Name the SSH host to add." };
  if (!SSH_DESTINATION.test(trimmed)) {
    return {
      ok: false,
      error: `"${trimmed.slice(0, 80)}" is not an SSH host alias Cogenly can use. Use an alias from your SSH config or user@host.`,
    };
  }
  return { ok: true, value: trimmed };
}

/** Checks a display name: visible characters only, one line, at most 64 characters. */
export function parseEnvironmentName(value: string): PromptLinkResult<string> {
  const sanitized = sanitizeLinkedPrompt(value);
  const name = sanitized.text.replace(/\s+/g, " ").trim();
  if (name.length === 0) {
    return {
      ok: false,
      error:
        sanitized.hiddenCharacters > 0
          ? "The environment name had only hidden characters."
          : "The environment name is empty.",
    };
  }
  if (Array.from(name).length > ENVIRONMENT_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Environment names are at most ${ENVIRONMENT_NAME_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, value: name };
}

/** Validates the fields every entry point receives. An omitted or blank name is null. */
export function parseAddEnvironmentRequest(input: {
  readonly ssh: string;
  readonly name?: string | null | undefined;
}): PromptLinkResult<AddEnvironmentRequest> {
  const ssh = parseSshDestination(input.ssh);
  if (!ssh.ok) return ssh;
  if (input.name === undefined || input.name === null || input.name.trim() === "") {
    return { ok: true, value: { ssh: ssh.value, name: null } };
  }
  const name = parseEnvironmentName(input.name);
  if (!name.ok) return name;
  return { ok: true, value: { ssh: ssh.value, name: name.value } };
}

const APP_SCHEME = /^cogenly(?:-[a-z]+)?:$/;

/**
 * Reads a `cogenly://environments/add` link. Null for any other URL, so callers can try their
 * other link kinds; an error when the link is this kind but malformed.
 */
export function parseAddEnvironmentLink(
  value: string,
): PromptLinkResult<AddEnvironmentRequest> | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (!APP_SCHEME.test(url.protocol) || url.host !== "environments") return null;
  if (url.pathname !== "/add" && url.pathname !== "/add/") return null;
  const ssh = url.searchParams.get("ssh");
  if (ssh === null) return { ok: false, error: "This link does not name an SSH host." };
  return parseAddEnvironmentRequest({ ssh, name: url.searchParams.get("name") });
}

/** The deep link that asks the desktop app to add `request`. */
export function buildAddEnvironmentLink(
  request: { readonly ssh: string; readonly name?: string | null },
  scheme = "cogenly",
): string {
  const params = new URLSearchParams({ ssh: request.ssh });
  if (request.name) params.set("name", request.name);
  // `URLSearchParams` writes spaces as `+`; `%20` reads the same and survives shells and chat.
  return `${scheme}://environments/add?${params.toString().replaceAll("+", "%20")}`;
}

// Hosting providers, recognized from the host's name or address. The first match wins.
const PROVIDERS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  // Contabo names its VPS `vmi<number>`, under contaboserver.net.
  { name: "Contabo", pattern: /contabo|^vmi\d{5,}(?:\.|$)/i },
  // Hetzner Cloud suggests `ubuntu-4gb-nbg1-1`; dedicated servers sit under your-server.de.
  { name: "Hetzner", pattern: /hetzner|your-server\.de|^[a-z]+-\d+gb-[a-z]{3}\d+-\d+$/i },
  // DigitalOcean suggests `ubuntu-s-1vcpu-1gb-nyc1-01`.
  { name: "DigitalOcean", pattern: /digitalocean|droplet|^[a-z]+-s-\d+vcpu-/i },
  { name: "Linode", pattern: /linode|akamai|^li\d+-\d+/i },
  { name: "Vultr", pattern: /vultr/i },
  { name: "OVH", pattern: /ovh|^vps-[0-9a-f]{8}(?:\.|$)/i },
  { name: "AWS", pattern: /amazonaws|^ip-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}(?:\.|$)/i },
  { name: "Oracle Cloud", pattern: /oraclevcn|oraclecloud/i },
  { name: "Google Cloud", pattern: /googleusercontent/i },
];

/** The hosting provider that names hosts like these, if one does. */
export function detectHostingProvider(
  names: ReadonlyArray<string | null | undefined>,
): string | null {
  for (const raw of names) {
    const name = raw?.trim();
    if (!name) continue;
    const provider = PROVIDERS.find((candidate) => candidate.pattern.test(name));
    if (provider) return provider.name;
  }
  return null;
}

const IP_ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]*:[0-9a-f:]+)$/i;

/**
 * True for a name a person would not have picked: an address, `localhost`, a provider's
 * generated hostname, or a single-word name with "t3" in it (a leftover SSH alias). Pretty
 * names with spaces are someone's choice and always count as human.
 */
function isMachineName(name: string): boolean {
  if (/\s/.test(name)) return false;
  return (
    IP_ADDRESS.test(name) ||
    /^localhost(?:\.|$)/i.test(name) ||
    /t3/i.test(name) ||
    detectHostingProvider([name]) !== null
  );
}

/**
 * The name to save an SSH environment under: the requested name, else the host's own pretty
 * name or hostname when a person chose it, else "<Provider> VPS" when the provider shows in
 * the host's name or address, else "VPS". Never the raw alias when it carries "t3".
 */
export function defaultSshEnvironmentName(input: {
  readonly requestedName?: string | null | undefined;
  /** The label the server reports: its pretty hostname, else its hostname. */
  readonly serverLabel?: string | null | undefined;
  readonly sshAlias: string;
  /** The address SSH resolved the alias to (`HostName`). */
  readonly sshHostname?: string | null | undefined;
}): string {
  const requested = input.requestedName?.trim();
  if (requested) {
    const parsed = parseEnvironmentName(requested);
    if (parsed.ok) return parsed.value;
  }
  const serverLabel = input.serverLabel?.replace(/\s+/g, " ").trim();
  if (serverLabel && !isMachineName(serverLabel)) {
    return Array.from(serverLabel).slice(0, ENVIRONMENT_NAME_MAX_LENGTH).join("");
  }
  const provider = detectHostingProvider([serverLabel, input.sshHostname, input.sshAlias]);
  return provider === null ? "VPS" : `${provider} VPS`;
}
