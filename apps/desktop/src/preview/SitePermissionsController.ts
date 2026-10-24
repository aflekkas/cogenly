/**
 * The preview browser's permission desk: answers a page's request at once when
 * the person (or an agent) already decided, otherwise parks it as a prompt
 * until the person answers. Every request belongs to one `webContents`, so the
 * prompt shows in that tab's toolbar. No Electron in here; `SitePermissions`
 * wires it to the session handlers.
 */
import type {
  SitePermission,
  SitePermissionDecidedBy,
  SitePermissionPrompt,
  SitePermissionPromptAnswer,
  SitePermissionSetting,
  SitePermissionsState,
} from "@cogenly/contracts";

import {
  permissionOriginOf,
  type SitePermissionChange,
  type SitePermissionStore,
} from "./SitePermissionStore.ts";

/** A page that keeps asking cannot stack more prompts than this on one tab. */
const MAX_PENDING_PER_TAB = 8;

export interface SitePermissionRequest {
  readonly partition: string;
  readonly origin: string;
  readonly permissions: ReadonlyArray<SitePermission>;
  readonly webContentsId: number;
  /** Called exactly once: true to grant the page, false to deny it. */
  readonly respond: (granted: boolean) => void;
}

interface PendingRequest extends SitePermissionRequest {
  readonly id: string;
}

export type SitePermissionPromptListener = (event: {
  readonly webContentsId: number;
  readonly prompt: SitePermissionPrompt | null;
}) => void;

export class SitePermissionsController {
  private readonly pending: PendingRequest[] = [];
  private readonly listeners = new Set<SitePermissionPromptListener>();

  private readonly store: SitePermissionStore;
  private readonly nextId: () => string;

  constructor(store: SitePermissionStore, nextId: () => string) {
    this.store = store;
    this.nextId = nextId;
  }

  /** Grants or denies at once when the origin is decided; otherwise waits for the person. */
  request(request: SitePermissionRequest): void {
    const verdict = this.store.evaluate(request.partition, request.origin, request.permissions);
    if (verdict.kind !== "ask") {
      request.respond(verdict.kind === "allow");
      return;
    }
    if (
      this.pending.filter((p) => p.webContentsId === request.webContentsId).length >=
      MAX_PENDING_PER_TAB
    ) {
      request.respond(false);
      return;
    }
    this.pending.push({ ...request, id: this.nextId() });
    this.emit(request.webContentsId);
  }

  /** The synchronous check Chromium makes for APIs that cannot wait for a prompt. */
  check(
    partition: string,
    origin: string,
    permissions: ReadonlyArray<SitePermission>,
    match: "all" | "any",
  ): boolean {
    const allowed = (permission: SitePermission) =>
      this.store.get(partition, origin, permission)?.setting === "allow";
    return match === "all" ? permissions.every(allowed) : permissions.some(allowed);
  }

  /** Records a decision for the origin and settles any request it now answers. */
  change(
    partition: string,
    origin: string,
    permission: SitePermission,
    setting: SitePermissionSetting,
    decidedBy: SitePermissionDecidedBy,
  ): SitePermissionChange {
    const result = this.store.change(partition, origin, permission, setting, decidedBy);
    if (result.ok) this.settle(partition, origin);
    return result;
  }

  /** The person answered the waiting request on a tab, or dismissed it. */
  answer(webContentsId: number, promptId: string, answer: SitePermissionPromptAnswer): void {
    const index = this.pending.findIndex(
      (request) => request.id === promptId && request.webContentsId === webContentsId,
    );
    const request = this.pending[index];
    if (!request) return;
    if (answer === "dismiss") {
      this.pending.splice(index, 1);
      request.respond(false);
      this.emit(webContentsId);
      return;
    }
    for (const permission of this.undecided(request)) {
      this.store.change(request.partition, request.origin, permission, answer, "user");
    }
    this.settle(request.partition, request.origin);
  }

  /**
   * Denies the tab's waiting requests: the tab closed, or left the origin that
   * asked. Requests from `keepOrigin` stay.
   */
  cancel(webContentsId: number, keepOrigin?: string): void {
    let changed = false;
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const request = this.pending[index]!;
      if (request.webContentsId !== webContentsId || request.origin === keepOrigin) continue;
      this.pending.splice(index, 1);
      request.respond(false);
      changed = true;
    }
    if (changed) this.emit(webContentsId);
  }

  /** The oldest request on the tab that still waits, as the toolbar shows it. */
  promptFor(webContentsId: number): SitePermissionPrompt | null {
    const request = this.pending.find((candidate) => candidate.webContentsId === webContentsId);
    if (!request) return null;
    return {
      id: request.id,
      origin: request.origin,
      permissions: this.undecided(request),
    };
  }

  /** A tab's permissions for the origin of `url`, with its waiting request. */
  state(
    partition: string,
    webContentsId: number | null,
    url: string | undefined,
  ): SitePermissionsState {
    const origin = permissionOriginOf(url);
    return {
      origin,
      entries: this.store.entries(partition, origin),
      prompt: webContentsId === null ? null : this.promptFor(webContentsId),
    };
  }

  onPromptChange(listener: SitePermissionPromptListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private undecided(request: SitePermissionRequest): ReadonlyArray<SitePermission> {
    const verdict = this.store.evaluate(request.partition, request.origin, request.permissions);
    return verdict.kind === "ask" ? verdict.undecided : request.permissions;
  }

  /** Answers every waiting request for the origin that a decision now settles. */
  private settle(partition: string, origin: string): void {
    const touched = new Set<number>();
    for (let index = 0; index < this.pending.length;) {
      const request = this.pending[index]!;
      if (request.partition !== partition || request.origin !== origin) {
        index += 1;
        continue;
      }
      const verdict = this.store.evaluate(partition, origin, request.permissions);
      touched.add(request.webContentsId);
      if (verdict.kind === "ask") {
        index += 1;
        continue;
      }
      this.pending.splice(index, 1);
      request.respond(verdict.kind === "allow");
    }
    for (const webContentsId of touched) this.emit(webContentsId);
  }

  private emit(webContentsId: number): void {
    const prompt = this.promptFor(webContentsId);
    for (const listener of this.listeners) listener({ webContentsId, prompt });
  }
}
