/**
 * Grok Build internals for tests: how Grok's ACP host is started, the
 * initialize parameters, environment, and the protocol parsers.
 *
 * @module provider-grok/testing
 */
export {
  createGrokAcpHost,
  grokAgentArgs,
  grokInitializeParams,
  makeGrokEnvironment,
  parseGrokInitializeResult,
  type GrokAcpHost,
  type GrokAcpHostOptions,
} from "./server/acp.ts";
export { parseGrokBilling, parseGrokAuthFile } from "./server/billing.ts";
export { parseGrokVersion } from "./server/maintenance.ts";
