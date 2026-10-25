/**
 * What health alerts say outside Cogenly, and which integration tool says it.
 * Alert text is built from health items, which never carry credentials, but
 * everything leaving through Slack or email still passes `sanitizeAlertText`.
 */
import type { IntegrationToolInfo, MachineHealthAlert } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const REDACTED = "[redacted]";

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // `token=...`, `password: ...`, `Authorization: ...` keep the name, drop the value.
  [
    /\b(access[_-]?token|refresh[_-]?token|token|secret|password|passwd|api[_-]?key|client[_-]?secret|authorization|cookie)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    `$1$2${REDACTED}`,
  ],
  // Provider-shaped keys: OpenAI/Anthropic, Slack, GitHub, AWS, Google OAuth, JWTs.
  [/\bsk-[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, REDACTED],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bya29\.[A-Za-z0-9._-]{8,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, REDACTED],
  // Any long unbroken run mixing letters and digits reads as key material.
  [/\b(?=[A-Za-z0-9+/_=-]{32,})(?=\S*[A-Za-z])(?=\S*\d)[A-Za-z0-9+/_=-]{32,}/g, REDACTED],
];

/** A URL keeps only its origin: paths, queries and userinfo can carry tokens. */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;

const stripUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? REDACTED : parsed.origin;
  } catch {
    return REDACTED;
  }
};

/** Defense in depth for text leaving Cogenly: one line, bounded, nothing token-like. */
export function sanitizeAlertText(text: string, maxLength = 300): string {
  let result = text.replace(URL_PATTERN, stripUrl);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  result = result.replaceAll(/\s+/g, " ").trim();
  return result.length > maxLength ? `${result.slice(0, maxLength - 1)}…` : result;
}

const HINT = "Open Cogenly → Settings → Machines for details.";

export interface AlertMessage {
  readonly subject: string;
  readonly text: string;
}

/** The Slack text and email for one transition this machine owns. */
export function alertMessage(
  alert: MachineHealthAlert,
  transition: "opened" | "resolved",
): AlertMessage {
  const machine = sanitizeAlertText(alert.originMachineName, 80);
  const title = sanitizeAlertText(alert.title, 160);
  const detail = sanitizeAlertText(alert.detail);
  const at =
    transition === "resolved" && alert.resolvedAt !== null ? alert.resolvedAt : alert.openedAt;
  const heading =
    transition === "opened"
      ? `Cogenly health alert on ${machine}: ${title}`
      : `Resolved on ${machine}: ${title}`;
  const lines = [
    heading,
    `Status: ${transition === "opened" ? alert.status : "resolved"}`,
    ...(detail.length > 0 ? [`Detail: ${detail}`] : []),
    `${transition === "opened" ? "Since" : "Resolved at"}: ${DateTime.formatIso(at)}`,
    HINT,
  ];
  return { subject: heading, text: lines.join("\n") };
}

export function testMessage(machineName: string): AlertMessage {
  const machine = sanitizeAlertText(machineName, 80);
  const subject = `Cogenly test alert from ${machine}`;
  return {
    subject,
    text: `${subject}\nThis is a test. Health alerts for ${machine} will arrive here.\n${HINT}`,
  };
}

interface ToolCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

const propertiesOf = (tool: IntegrationToolInfo): Record<string, unknown> => {
  const schema = tool.inputSchema;
  if (typeof schema !== "object" || schema === null || !("properties" in schema)) return {};
  const properties = schema.properties;
  return typeof properties === "object" && properties !== null
    ? (properties as Record<string, unknown>)
    : {};
};

const pickKey = (properties: Record<string, unknown>, candidates: ReadonlyArray<string>) =>
  candidates.find((candidate) => candidate in properties);

const isArrayProperty = (property: unknown) =>
  typeof property === "object" && property !== null && "type" in property
    ? property.type === "array"
    : false;

const findTool = (
  tools: ReadonlyArray<IntegrationToolInfo>,
  preferred: ReadonlyArray<string>,
  matches: (name: string) => boolean,
) =>
  preferred
    .map((name) => tools.find((tool) => tool.name === name))
    .find((tool) => tool !== undefined) ?? tools.find((tool) => matches(tool.name.toLowerCase()));

const NOT_SENDING = /draft|schedule|ephemeral|reaction|reply|forward|label/;

/** Slack: a send/post-message tool, with the member id as the channel (a DM). */
export function slackSendCall(
  tools: ReadonlyArray<IntegrationToolInfo>,
  userId: string,
  text: string,
): ToolCall | null {
  const tool = findTool(
    tools,
    [
      "slack_send_message",
      "send_message",
      "slack_post_message",
      "post_message",
      "chat_postMessage",
    ],
    (name) => /(send|post)_?message|chat_?post/.test(name) && !NOT_SENDING.test(name),
  );
  if (tool === undefined) return null;
  const properties = propertiesOf(tool);
  const channel = pickKey(properties, ["channel_id", "channel", "channelId", "conversation_id"]);
  const body = pickKey(properties, ["message", "text", "markdown_text", "content", "body"]);
  return {
    tool: tool.name,
    args: { [channel ?? "channel_id"]: userId, [body ?? "text"]: text },
  };
}

/** Google Workspace: the Gmail send tool. */
export function emailSendCall(
  tools: ReadonlyArray<IntegrationToolInfo>,
  to: string,
  message: AlertMessage,
): ToolCall | null {
  const tool = findTool(
    tools,
    ["send_gmail_message", "gmail_send_message", "send_email", "send_message"],
    (name) => /send/.test(name) && /mail|message/.test(name) && !NOT_SENDING.test(name),
  );
  if (tool === undefined) return null;
  const properties = propertiesOf(tool);
  const toKey = pickKey(properties, ["to", "recipient", "recipients"]) ?? "to";
  const bodyKey = pickKey(properties, ["body", "text", "content", "message"]) ?? "body";
  return {
    tool: tool.name,
    args: {
      [toKey]: isArrayProperty(properties[toKey]) ? [to] : to,
      subject: message.subject,
      [bodyKey]: message.text,
      // workspace-mcp in single-user mode, as LocalIntegrations signs in.
      ...("user_google_email" in properties ? { user_google_email: "default" } : {}),
    },
  };
}
