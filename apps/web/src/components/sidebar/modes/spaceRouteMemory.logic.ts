/**
 * Each space on the rail (Chats, Work, Agents, Projects, and Settings)
 * remembers the page it last showed, so switching away and back returns to
 * it instead of landing afresh. A space's memory is the href (path and
 * search) of its last page and what that page shows, so a return can check
 * the thread or project is still there before going back to it.
 */
import type { SidebarMode, SidebarThreadMode } from "./sidebarModes.logic";

export type SidebarSpace = SidebarMode | "settings";

export const SIDEBAR_SPACES: ReadonlyArray<SidebarSpace> = [
  "chats",
  "tasks",
  "agents",
  "projects",
  "settings",
];

/** What a remembered page shows. */
export type SpaceRoute =
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | { readonly kind: "draft"; readonly draftId: string }
  | { readonly kind: "project"; readonly environmentId: string; readonly labelId: string }
  | { readonly kind: "projects-overview" }
  | { readonly kind: "new-agent" }
  | { readonly kind: "settings" };

export interface RememberedSpaceRoute {
  readonly href: string;
  readonly route: SpaceRoute;
}

export type SpaceRouteMemory = Partial<Record<SidebarSpace, RememberedSpaceRoute>>;

/**
 * The page a route match shows, from the router's leaf match. Null for pages
 * no space owns: the index (it lands on its own), Usage, legacy links, and
 * the connect and welcome flows.
 */
export function spaceRouteForMatch(match: {
  readonly routeId: string;
  readonly params: Readonly<Record<string, string | undefined>>;
}): SpaceRoute | null {
  const { routeId, params } = match;
  if (routeId === "/settings" || routeId.startsWith("/settings/")) return { kind: "settings" };
  switch (routeId) {
    case "/_chat/$environmentId/$threadId":
      return params.environmentId && params.threadId
        ? { kind: "thread", environmentId: params.environmentId, threadId: params.threadId }
        : null;
    case "/_chat/draft/$draftId":
      return params.draftId ? { kind: "draft", draftId: params.draftId } : null;
    case "/_chat/project/$environmentId/$labelId":
      return params.environmentId && params.labelId
        ? { kind: "project", environmentId: params.environmentId, labelId: params.labelId }
        : null;
    case "/_chat/project/":
      return { kind: "projects-overview" };
    case "/_chat/agents/new":
      return { kind: "new-agent" };
    default:
      return null;
  }
}

/**
 * The space a page belongs to. A thread or draft belongs to the mode that
 * lists it, which `threadMode` gives; null while that is not known yet.
 */
export function spaceOfRoute(
  route: SpaceRoute,
  threadMode: SidebarThreadMode | null,
): SidebarSpace | null {
  switch (route.kind) {
    case "thread":
    case "draft":
      return threadMode;
    case "project":
    case "projects-overview":
      return "projects";
    case "new-agent":
      return "agents";
    case "settings":
      return "settings";
  }
}

export function rememberSpaceRoute(
  memory: SpaceRouteMemory,
  space: SidebarSpace,
  entry: RememberedSpaceRoute,
): SpaceRouteMemory {
  const current = memory[space];
  if (current?.href === entry.href) return memory;
  return { ...memory, [space]: entry };
}

export function forgetSpaceRoute(memory: SpaceRouteMemory, space: SidebarSpace): SpaceRouteMemory {
  if (memory[space] === undefined) return memory;
  const { [space]: _forgotten, ...rest } = memory;
  return rest;
}

/**
 * Whether a remembered page can still be shown: "gone" when its thread was
 * deleted or archived, moved to another space, or its project or draft no
 * longer exists; "unknown" while that cannot be told yet (still loading),
 * which still returns there and lets the page show its own loading state.
 */
export type SpaceRouteAvailability = "available" | "gone" | "unknown";

/** Where switching to `space` returns, or null to land on it afresh. */
export function resolveSpaceReturn(
  memory: SpaceRouteMemory,
  space: SidebarSpace,
  availability: (route: SpaceRoute, space: SidebarSpace) => SpaceRouteAvailability,
): string | null {
  const entry = memory[space];
  if (entry === undefined) return null;
  // A stale entry from another space (or a corrupted store) never sends a
  // space to a page it does not own.
  if (spaceOfRoute(entry.route, isThreadSpace(space) ? space : null) !== space) return null;
  return availability(entry.route, space) === "gone" ? null : entry.href;
}

function isThreadSpace(space: SidebarSpace): space is SidebarThreadMode {
  return space === "chats" || space === "tasks" || space === "agents";
}

function isSidebarSpace(value: unknown): value is SidebarSpace {
  return SIDEBAR_SPACES.includes(value as SidebarSpace);
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function parseSpaceRoute(value: unknown): SpaceRoute | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "thread":
      return isNonEmptyString(record.environmentId) && isNonEmptyString(record.threadId)
        ? { kind: "thread", environmentId: record.environmentId, threadId: record.threadId }
        : null;
    case "draft":
      return isNonEmptyString(record.draftId) ? { kind: "draft", draftId: record.draftId } : null;
    case "project":
      return isNonEmptyString(record.environmentId) && isNonEmptyString(record.labelId)
        ? { kind: "project", environmentId: record.environmentId, labelId: record.labelId }
        : null;
    case "projects-overview":
    case "new-agent":
    case "settings":
      return { kind: record.kind };
    default:
      return null;
  }
}

/** Reads stored memory, dropping anything malformed or not an in-app path. */
export function parseStoredSpaceRouteMemory(raw: unknown): SpaceRouteMemory {
  if (typeof raw !== "object" || raw === null) return {};
  const memory: { [Space in SidebarSpace]?: RememberedSpaceRoute } = {};
  for (const [space, value] of Object.entries(raw)) {
    if (!isSidebarSpace(space) || typeof value !== "object" || value === null) continue;
    const { href, route } = value as Record<string, unknown>;
    const parsedRoute = parseSpaceRoute(route);
    if (!isNonEmptyString(href) || !href.startsWith("/") || href.startsWith("//")) continue;
    if (parsedRoute === null) continue;
    memory[space] = { href, route: parsedRoute };
  }
  return memory;
}
