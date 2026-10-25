import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { T3ProjectFile } from "@cogenly/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `cogenly.json` file contents (lenient JSONC string) and the
 * decoded {@link T3ProjectFile}.
 */
export const T3ProjectFileFromJson = fromLenientJson(T3ProjectFile);

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

/**
 * Decode raw `cogenly.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseT3ProjectFile(contents: string): T3ProjectFile | null {
  const decoded = decodeT3ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}
