function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A Claude `Skill` call: the skill it loads and the arguments it passes, if any. */
export function claudeSkillInvocation(
  toolName: string | null | undefined,
  input: unknown,
): { readonly name: string; readonly args: string | undefined } | undefined {
  if (toolName !== "Skill") return undefined;
  const record = asRecord(input);
  const name = asTrimmedString(record?.skill);
  return name === undefined ? undefined : { name, args: asTrimmedString(record?.args) };
}

export function isJavaScriptReplTool(toolName: string | null | undefined): boolean {
  return toolName === "js" || toolName === "cua_repl.js" || toolName === "node_repl.js";
}

export const COMPUTER_USE_TOOL_SOURCE = {
  key: "computer-use",
  name: "Computer Use",
  kind: "computer",
} as const;

/** Computer-use calls may fail or still be running before result metadata is available. */
export function dynamicToolSurface(toolName: string | null | undefined, input: unknown) {
  if (toolName === "cua_repl.js") return "computer" as const;
  const code = asRecord(input)?.code;
  return isJavaScriptReplTool(toolName) &&
    typeof code === "string" &&
    (/\bsky\s*\./u.test(code) || /["']@oai\/sky["']/u.test(code))
    ? ("computer" as const)
    : undefined;
}

/**
 * Activity log heading a dynamic tool derives from its input: a REPL's `title`,
 * or the skill a Claude `Skill` call loads.
 */
export function dynamicToolTitle(
  toolName: string | null | undefined,
  input: unknown,
  retainedTitle?: string | null,
): string | undefined {
  if (isJavaScriptReplTool(toolName)) {
    const title = asTrimmedString(retainedTitle);
    const meaningfulTitle =
      title && title.toLowerCase() !== "js" && title.toLowerCase() !== toolName?.toLowerCase()
        ? title
        : undefined;
    return (
      asTrimmedString(asRecord(input)?.title) ??
      meaningfulTitle ??
      (dynamicToolSurface(toolName, input) === "computer" ? "Computer use" : "Run JavaScript")
    );
  }
  const skill = claudeSkillInvocation(toolName, input);
  return skill === undefined ? undefined : `Skill: ${skill.name}`;
}

function recordHasKeys(
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> {
  return value !== undefined && Object.keys(value).length > 0;
}

const PATH_KEYS = [
  "path",
  "filePath",
  "file_path",
  "relativePath",
  "filename",
  "fileName",
  "newPath",
  "oldPath",
] as const;

function collectPaths(value: unknown, paths: string[], seen: Set<string>, depth: number): void {
  if (depth > 4 || paths.length >= 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, seen, depth + 1);
      if (paths.length >= 8) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of PATH_KEYS) {
    const candidate = asTrimmedString(record[key]);
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    paths.push(candidate);
    if (paths.length >= 8) {
      return;
    }
  }
  for (const nestedKey of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPaths(record[nestedKey], paths, seen, depth + 1);
    if (paths.length >= 8) {
      return;
    }
  }
}

/** Structured paths from tool input, never file-body text. */
export function collectToolFilePaths(data: unknown): string[] {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths;
}

/**
 * Later ACP updates often resend `rawInput: {}`. Keep the first object that
 * actually carried keys so a parsed path is not wiped out.
 */
export function mergeToolActivityData(
  previous: unknown,
  next: unknown,
): Record<string, unknown> | undefined {
  const previousRecord = asRecord(previous);
  const nextRecord = asRecord(next);
  if (!nextRecord) {
    return previousRecord;
  }
  if (!previousRecord) {
    return nextRecord;
  }
  const previousInput = asRecord(previousRecord.rawInput);
  const nextInput = asRecord(nextRecord.rawInput);
  const rawInput = recordHasKeys(nextInput)
    ? { ...previousInput, ...nextInput }
    : (previousInput ?? nextInput);
  const merged = { ...previousRecord, ...nextRecord };
  if (recordHasKeys(rawInput)) {
    merged.rawInput = rawInput;
  } else {
    delete merged.rawInput;
  }
  return merged;
}

const SEARCH_QUERY_KEYS = ["pattern", "query", "searchTerm", "regex", "grep", "needle"] as const;
const SEARCH_GLOB_KEYS = [
  "glob",
  "globPattern",
  "glob_pattern",
  "include",
  "filePattern",
  "file_pattern",
] as const;
const SEARCH_TARGET_KEYS = [
  "path",
  "target_directory",
  "targetDirectory",
  "directory",
  "cwd",
  "root",
] as const;

function firstInputString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = asTrimmedString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function searchInputRecord(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return (
    [data?.rawInput, data?.input, asRecord(data?.item)?.input]
      .map(asRecord)
      .find((record) => recordHasKeys(record ?? undefined)) ?? data
  );
}

function searchTargetName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.split(/[\\/]/u).findLast((part) => part.length > 0 && part !== ".");
}

/** Cursor-style row: "Searched files *.{ts,tsx} in t3chat-new". */
export function formatSearchToolLabel(
  data: Record<string, unknown> | undefined,
): string | undefined {
  const input = searchInputRecord(data);
  const query = firstInputString(input, SEARCH_QUERY_KEYS);
  const glob = firstInputString(input, SEARCH_GLOB_KEYS);
  const target = searchTargetName(firstInputString(input, SEARCH_TARGET_KEYS));
  if (query && target) {
    return `Searched ${query} in ${target}`;
  }
  if (glob && target) {
    return `Searched files ${glob} in ${target}`;
  }
  if (glob) {
    return `Searched files ${glob}`;
  }
  if (query) {
    return `Searched ${query}`;
  }
  if (target) {
    return `Searched in ${target}`;
  }
  return undefined;
}

/** Work-log heading for a file read: verb plus the structured path, never the path alone. */
export function formatReadToolLabel(path: string, extraCount = 0): string {
  const trimmed = path.trim();
  const suffix = extraCount > 0 ? ` +${extraCount} more` : "";
  if (!trimmed) {
    return `Read file${suffix}`;
  }
  return `Read ${trimmed}${suffix}`;
}
