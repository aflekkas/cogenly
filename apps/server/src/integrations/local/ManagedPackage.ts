/** Resolve an exact registry release without a shell or a global package installation. */
export const managedPackageCommand = (input: {
  readonly ecosystem: "python" | "node";
  readonly name: string;
  readonly version: string;
}) =>
  input.ecosystem === "python"
    ? { runtime: "uvx", args: [`${input.name}@${input.version}`] }
    : { runtime: "npx", args: ["-y", `${input.name}@${input.version}`] };
