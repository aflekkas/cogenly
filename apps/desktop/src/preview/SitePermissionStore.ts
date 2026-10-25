/**
 * Which site permissions a preview page may use, remembered per origin and per
 * browser profile (the session partition). Pure bookkeeping with no Electron
 * in it: `SitePermissions` wires it to the session's permission handlers and
 * to the prompt, and tests drive it directly.
 */
import {
  SITE_PERMISSIONS,
  type SitePermission,
  type SitePermissionDecidedBy,
  type SitePermissionEntry,
  type SitePermissionSetting,
} from "@cogenly/contracts";

export interface StoredSitePermission {
  readonly setting: "allow" | "block";
  readonly decidedBy: SitePermissionDecidedBy;
}

/** The on-disk form: partition -> origin -> permission -> decision. */
export interface SitePermissionSnapshot {
  readonly version: 1;
  readonly partitions: Readonly<
    Record<string, Readonly<Record<string, Partial<Record<SitePermission, StoredSitePermission>>>>>
  >;
}

export type SitePermissionChange =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "user-blocked" };

const isSitePermission = (value: string): value is SitePermission =>
  (SITE_PERMISSIONS as readonly string[]).includes(value);

/** The origin permissions are keyed by; null for anything but a web page. */
export function permissionOriginOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The site permissions an Electron permission request is asking for, or null
 * when it is not one a person can grant (it stays denied). `media` carries
 * camera and microphone together, so each is decided on its own.
 */
export function sitePermissionsForRequest(
  permission: string,
  mediaTypes?: ReadonlyArray<"video" | "audio">,
): ReadonlyArray<SitePermission> | null {
  switch (permission) {
    case "media": {
      const wanted: SitePermission[] = [];
      if (!mediaTypes || mediaTypes.length === 0 || mediaTypes.includes("video")) {
        wanted.push("camera");
      }
      if (!mediaTypes || mediaTypes.length === 0 || mediaTypes.includes("audio")) {
        wanted.push("microphone");
      }
      return wanted;
    }
    case "geolocation":
    case "geolocation-approximate":
      return ["geolocation"];
    case "notifications":
      return ["notifications"];
    case "clipboard-read":
      return ["clipboard-read"];
    case "midi":
    case "midiSysex":
      return ["midi"];
    default:
      return null;
  }
}

export type SitePermissionVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "block" }
  /** `undecided` are the permissions the person has to answer for. */
  | { readonly kind: "ask"; readonly undecided: ReadonlyArray<SitePermission> };

export class SitePermissionStore {
  private readonly decisions = new Map<
    string,
    Map<string, Map<SitePermission, StoredSitePermission>>
  >();

  private readonly options: {
    /** Incognito partitions are kept in memory only. */
    readonly isPersistent: (partition: string) => boolean;
    readonly onChange: () => void;
  };

  constructor(
    snapshot: unknown,
    options: {
      readonly isPersistent: (partition: string) => boolean;
      readonly onChange: () => void;
    },
  ) {
    this.options = options;
    this.loading = true;
    this.load(snapshot);
    this.loading = false;
  }

  /** Loading replays saved decisions through `change`, which must not write them back. */
  private loading = false;

  get(
    partition: string,
    origin: string,
    permission: SitePermission,
  ): StoredSitePermission | undefined {
    return this.decisions.get(partition)?.get(origin)?.get(permission);
  }

  /** What a page asking for `permissions` gets: one Block anywhere blocks the lot. */
  evaluate(
    partition: string,
    origin: string,
    permissions: ReadonlyArray<SitePermission>,
  ): SitePermissionVerdict {
    const undecided: SitePermission[] = [];
    for (const permission of permissions) {
      const decision = this.get(partition, origin, permission);
      if (decision?.setting === "block") return { kind: "block" };
      if (decision === undefined) undecided.push(permission);
    }
    return undecided.length === 0 ? { kind: "allow" } : { kind: "ask", undecided };
  }

  /**
   * Records a decision, or clears it for `ask`. An agent may decide what the
   * person has not decided and may tighten what they allowed, but a person's
   * explicit Block stays until the person lifts it.
   */
  change(
    partition: string,
    origin: string,
    permission: SitePermission,
    setting: SitePermissionSetting,
    decidedBy: SitePermissionDecidedBy,
  ): SitePermissionChange {
    const existing = this.get(partition, origin, permission);
    if (decidedBy === "agent" && existing?.setting === "block" && existing.decidedBy === "user") {
      return { ok: false, reason: "user-blocked" };
    }
    if (setting === "ask") {
      if (existing === undefined) return { ok: true };
      const forOrigin = this.decisions.get(partition)?.get(origin);
      forOrigin?.delete(permission);
      if (forOrigin?.size === 0) this.decisions.get(partition)?.delete(origin);
      if (this.decisions.get(partition)?.size === 0) this.decisions.delete(partition);
    } else {
      let origins = this.decisions.get(partition);
      if (!origins) this.decisions.set(partition, (origins = new Map()));
      let permissions = origins.get(origin);
      if (!permissions) origins.set(origin, (permissions = new Map()));
      permissions.set(permission, { setting, decidedBy });
    }
    if (!this.loading && this.options.isPersistent(partition)) this.options.onChange();
    return { ok: true };
  }

  /** Every supported permission for the origin, in a fixed order. */
  entries(partition: string, origin: string | null): ReadonlyArray<SitePermissionEntry> {
    return SITE_PERMISSIONS.map((permission) => {
      const decision = origin === null ? undefined : this.get(partition, origin, permission);
      return decision === undefined
        ? { permission, setting: "ask" as const }
        : { permission, setting: decision.setting, decidedBy: decision.decidedBy };
    });
  }

  snapshot(): SitePermissionSnapshot {
    const partitions: Record<
      string,
      Record<string, Partial<Record<SitePermission, StoredSitePermission>>>
    > = {};
    for (const [partition, origins] of this.decisions) {
      if (!this.options.isPersistent(partition)) continue;
      const saved: Record<string, Partial<Record<SitePermission, StoredSitePermission>>> = {};
      for (const [origin, permissions] of origins) {
        saved[origin] = Object.fromEntries(permissions) as Partial<
          Record<SitePermission, StoredSitePermission>
        >;
      }
      partitions[partition] = saved;
    }
    return { version: 1, partitions };
  }

  /** Reads a saved file defensively: anything malformed is dropped, never thrown. */
  private load(snapshot: unknown): void {
    const partitions = (snapshot as { partitions?: unknown } | null)?.partitions;
    if (typeof partitions !== "object" || partitions === null) return;
    for (const [partition, origins] of Object.entries(partitions)) {
      if (typeof origins !== "object" || origins === null) continue;
      for (const [origin, permissions] of Object.entries(origins)) {
        if (permissionOriginOf(origin) !== origin) continue;
        if (typeof permissions !== "object" || permissions === null) continue;
        for (const [permission, decision] of Object.entries(permissions)) {
          if (!isSitePermission(permission)) continue;
          const { setting, decidedBy } = (decision ?? {}) as Record<string, unknown>;
          if (setting !== "allow" && setting !== "block") continue;
          if (decidedBy !== "user" && decidedBy !== "agent") continue;
          this.change(partition, origin, permission, setting, decidedBy);
        }
      }
    }
  }
}
