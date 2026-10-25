import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@cogenly/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Settings → Integrations: the environment's upstream MCP servers. The list is
 * live: the server pushes it again after every change, including a sign-in
 * finished in another browser or started by an agent.
 */
export const integrationsRpc = {
  previewNative: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:previewNative",
    tag: "integrations.previewNative",
  }),
  importNative: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:importNative",
    tag: "integrations.importNative",
  }),
  list: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "integrations:live",
    tag: "integrations.subscribe",
  }),
  create: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:create",
    tag: "integrations.create",
  }),
  update: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:update",
    tag: "integrations.update",
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:delete",
    tag: "integrations.delete",
  }),
  testConnection: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:testConnection",
    tag: "integrations.testConnection",
  }),
  /** A link to the service's sign-in page; it returns to the origin this client reached. */
  beginSignIn: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:beginSignIn",
    tag: "integrations.beginSignIn",
  }),
  /**
   * Connects a default catalog entry; its sign-in link comes back like
   * beginSignIn's, or the setup step to show when something comes first.
   */
  connectFromCatalog: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:connectFromCatalog",
    tag: "integrations.connectFromCatalog",
  }),
  /** An app's client id and secret from the setup form; the secret goes to the vault. */
  saveOAuthClient: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:saveOAuthClient",
    tag: "integrations.saveOAuthClient",
  }),
  /** An API key from the setup form; it goes to the vault. */
  saveApiKey: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:saveApiKey",
    tag: "integrations.saveApiKey",
  }),
  /** Installs uv for the Google account's managed server. */
  installRuntime: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:installRuntime",
    tag: "integrations.installRuntime",
  }),
  /** Connected accounts for the composer's Sources picker, pushed on every change. */
  sources: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "integrations:sources",
    tag: "integrations.subscribeSources",
  }),
};
