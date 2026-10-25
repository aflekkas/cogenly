import { createEnvironmentRpcCommand } from "@cogenly/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

// One page's writes land in the order it made them, so a quick run of answers
// never reaches the server out of order.
const perRender = {
  mode: "serial" as const,
  key: (target: { readonly input: { readonly threadId: string; readonly renderId: string } }) =>
    `${target.input.threadId}\u0000${target.input.renderId}`,
};

/** The interactive render bridge's reads and writes of a render's stored document. */
export const visualStateRpc = {
  get: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "visual:state:get",
    tag: "visual.state.get",
  }),
  set: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "visual:state:set",
    tag: "visual.state.set",
    concurrency: perRender,
  }),
  submit: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "visual:state:submit",
    tag: "visual.state.submit",
    concurrency: perRender,
  }),
};
