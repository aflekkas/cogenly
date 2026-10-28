/**
 * What Cogenly reads from an extension's manifest.json: the name and
 * description it shows (resolving `__MSG_name__` from the default locale), the
 * permissions it lists, and the popup and options pages agents can open.
 */

export interface ExtensionManifestSummary {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly manifestVersion: number;
  readonly permissions: ReadonlyArray<string>;
  readonly hostPermissions: ReadonlyArray<string>;
  readonly iconPaths: ReadonlyArray<string>;
  readonly hasAction: boolean;
  readonly sidePanelPage?: string;
  readonly popupPage?: string;
  readonly optionsPage?: string;
  /** The manifest's own `key`, base64 DER, which fixes the extension's ID. */
  readonly key?: string;
}

export class ExtensionManifestError extends Error {
  override readonly name = "ExtensionManifestError";
}

type Messages = Readonly<Record<string, { readonly message?: unknown } | undefined>>;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** A manifest permission that names sites rather than an API. */
const isHostPattern = (permission: string) =>
  permission === "<all_urls>" || permission.includes("://");

/** Resolves `__MSG_key__` the way Chrome does: keys are case-insensitive. */
const localize = (value: string, messages: Messages | undefined) =>
  value.replace(/__MSG_([A-Za-z0-9_@]+)__/g, (whole, key: string) => {
    if (!messages) return whole;
    const lower = key.toLowerCase();
    const entry = Object.entries(messages).find(([name]) => name.toLowerCase() === lower)?.[1];
    return typeof entry?.message === "string" ? entry.message : whole;
  });

/** The default locale's messages file, relative to the extension root, if the manifest names one. */
export const manifestMessagesPath = (manifest: unknown) => {
  const locale = text(record(manifest)?.default_locale);
  return locale && /^[A-Za-z0-9_-]+$/.test(locale) ? `_locales/${locale}/messages.json` : undefined;
};

/** Prefer toolbar art, choosing the size closest to 32 CSS pixels. */
const iconPaths = (icons: unknown): string[] => {
  if (typeof icons === "string") return [icons];
  const sizes = Object.entries(record(icons) ?? {})
    .filter(([size, path]) => Number(size) > 0 && typeof path === "string")
    .sort(
      ([a], [b]) => Math.abs(Number(a) - 32) - Math.abs(Number(b) - 32) || Number(b) - Number(a),
    );
  return sizes.flatMap(([, path]) => (typeof path === "string" ? [path] : []));
};

export const summarizeManifest = (
  manifest: unknown,
  messages?: unknown,
): ExtensionManifestSummary => {
  const root = record(manifest);
  if (!root) throw new ExtensionManifestError("manifest.json is not a JSON object.");
  const manifestVersion = root.manifest_version;
  if (manifestVersion !== 2 && manifestVersion !== 3) {
    throw new ExtensionManifestError("manifest.json needs manifest_version 2 or 3.");
  }
  const rawName = text(root.name)?.trim();
  const version = text(root.version)?.trim();
  if (!rawName) throw new ExtensionManifestError("manifest.json has no name.");
  if (!version || !/^\d+(\.\d+){0,3}$/.test(version)) {
    throw new ExtensionManifestError("manifest.json has no valid version.");
  }
  const localized = record(messages) as Messages | undefined;
  const permissions = strings(root.permissions);
  const hosts = new Set<string>([
    ...permissions.filter(isHostPattern),
    ...strings(root.host_permissions),
  ]);
  for (const script of Array.isArray(root.content_scripts) ? root.content_scripts : []) {
    for (const match of strings(record(script)?.matches)) hosts.add(match);
  }
  const action = record(
    manifestVersion === 3 ? root.action : (root.browser_action ?? root.page_action),
  );
  const popupPage = text(action?.default_popup);
  const icons = [...new Set([...iconPaths(action?.default_icon), ...iconPaths(root.icons)])];
  const sidePanelPage = text(record(root.side_panel)?.default_path);
  const optionsPage = text(record(root.options_ui)?.page) ?? text(root.options_page);
  const key = text(root.key);
  return {
    name: localize(rawName, localized),
    version,
    description: localize(text(root.description) ?? "", localized),
    manifestVersion,
    permissions: permissions.filter((permission) => !isHostPattern(permission)),
    hostPermissions: [...hosts],
    hasAction: action !== undefined,
    iconPaths: icons,
    ...(sidePanelPage ? { sidePanelPage: sidePanelPage.replace(/^\/+/, "") } : {}),
    ...(popupPage ? { popupPage: popupPage.replace(/^\/+/, "") } : {}),
    ...(optionsPage ? { optionsPage: optionsPage.replace(/^\/+/, "") } : {}),
    ...(key ? { key } : {}),
  };
};
