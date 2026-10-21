/**
 * What a "copied" toast says. The title names the kind of thing copied and
 * the label is a short, human name for it (a thread title, a folder, a
 * branch), never the raw clipboard text: no markdown and no URLs.
 */
export type CopiedToastSubject =
  | { readonly kind: "clipboard" }
  | { readonly kind: "thread-link"; readonly link: string; readonly threadTitle?: string }
  | { readonly kind: "thread-id"; readonly threadId: string; readonly threadTitle?: string }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "branch"; readonly branch: string };

export type CopiedToastIcon = "thread" | "folder" | "branch" | null;

export interface CopiedToastContent {
  readonly title: string;
  readonly label: string | null;
  readonly icon: CopiedToastIcon;
}

const MAX_LABEL_LENGTH = 80;

/**
 * Plain text for a toast label: markdown links keep their text, bare URLs are
 * dropped, whitespace collapses, and long
 * text ends in an ellipsis. Null when nothing readable is left.
 */
export function plainToastLabel(text: string | null | undefined): string | null {
  if (!text) return null;
  const plain = text
    // [label](target) -> label
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // scheme://anything (https, cogenly-thread, file, ...)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length === 0) return null;
  return plain.length > MAX_LABEL_LENGTH ? `${plain.slice(0, MAX_LABEL_LENGTH - 1)}…` : plain;
}

function lastPathSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  return segments.at(-1) || trimmed || path;
}

export function describeCopiedToast(subject: CopiedToastSubject): CopiedToastContent {
  switch (subject.kind) {
    // Message and other content copies: what was copied is already on screen.
    case "clipboard":
      return { title: "Copied to clipboard", label: null, icon: null };
    case "thread-link":
      return {
        title: "Link copied",
        label: plainToastLabel(subject.threadTitle ?? subject.link),
        icon: "thread",
      };
    case "thread-id":
      return {
        title: "Thread ID copied",
        label: plainToastLabel(subject.threadTitle) ?? plainToastLabel(subject.threadId),
        icon: "thread",
      };
    case "path":
      return {
        title: "Path copied",
        label: plainToastLabel(lastPathSegment(subject.path)),
        icon: "folder",
      };
    case "branch":
      return { title: "Branch copied", label: plainToastLabel(subject.branch), icon: "branch" };
  }
}

/** How long a copy button holds its check icon after a copy lands. */
export const COPY_CONFIRMATION_MS = 1500;
