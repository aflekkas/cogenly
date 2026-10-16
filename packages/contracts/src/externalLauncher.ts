import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
export const FileManagerRevealKind = Schema.Literals(["finder", "file-explorer", "files"]);
export type FileManagerRevealKind = typeof FileManagerRevealKind.Type;
export const RevealInFileManagerInput = Schema.Struct({ path: TrimmedNonEmptyString });
const ExternalLauncherSpawnFields = {
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cause: Schema.Defect(),
};

export class ExternalLauncherBrowserSpawnError extends Schema.TaggedError<ExternalLauncherBrowserSpawnError>()(
  "ExternalLauncherBrowserSpawnError",
  {
    ...ExternalLauncherSpawnFields,
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to launch browser target '${this.target}' with '${[this.command, ...this.args].join(" ")}'`;
  }
}

export class ExternalLauncherFileManagerSpawnError extends Schema.TaggedError<ExternalLauncherFileManagerSpawnError>()(
  "ExternalLauncherFileManagerSpawnError",
  { ...ExternalLauncherSpawnFields, target: Schema.String },
) {
  override get message(): string {
    return `Failed to reveal '${this.target}' in the file manager`;
  }
}

export const ExternalLauncherError = Schema.Union([
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherFileManagerSpawnError,
]);
export type ExternalLauncherError = typeof ExternalLauncherError.Type;
