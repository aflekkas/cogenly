interface ExtensionDirectory {
  readonly id: string;
  readonly path: string;
}

/**
 * What to change so a profile's session runs exactly `wanted`. An extension
 * loaded from another directory is an update: unload it, then load the new one.
 */
export const planExtensionLoad = (
  loaded: ReadonlyArray<ExtensionDirectory>,
  wanted: ReadonlyArray<ExtensionDirectory>,
) => {
  const wantedById = new Map(wanted.map((extension) => [extension.id, extension.path]));
  const unload = loaded
    .filter((extension) => wantedById.get(extension.id) !== extension.path)
    .map((extension) => extension.id);
  const loadedPaths = new Set(loaded.map((extension) => `${extension.id}\n${extension.path}`));
  const load = wanted.filter((extension) => !loadedPaths.has(`${extension.id}\n${extension.path}`));
  return { unload, load };
};
