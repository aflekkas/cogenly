import { createExportAtoms } from "@t3tools/client-runtime/state/exports";
import { connectionAtomRuntime } from "../connection/runtime";

/** Portable workspace exports: create, validate, and list recent bundles. */
export const exportRpc = createExportAtoms(connectionAtomRuntime);
