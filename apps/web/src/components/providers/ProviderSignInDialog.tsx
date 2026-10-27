import { providerSignInTitle } from "@cogenly/client-runtime/provider-sign-in";
import { useEffect } from "react";
import { create } from "zustand";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { OverlayPresence } from "../ui/overlay-presence";
import {
  ProviderSignInFlow,
  type ProviderSignInRequest,
  useProviderSignInFlow,
  useResolvedProviderSignIn,
} from "./ProviderSignInFlow";

type Pending = {
  readonly request: ProviderSignInRequest;
  readonly resolve: (signedIn: boolean) => void;
};
const usePending = create<{ pending: Pending | null }>(() => ({ pending: null }));

/**
 * Opens the guided sign-in for one provider on one machine. Resolves true once
 * that machine is signed in, false when the user closes it first, so a caller
 * can pick up where the user was (for example, send the blocked message).
 */
export function openProviderSignIn(request: ProviderSignInRequest): Promise<boolean> {
  usePending.getState().pending?.resolve(false);
  return new Promise((resolve) => usePending.setState({ pending: { request, resolve } }));
}

function finish(signedIn: boolean) {
  const pending = usePending.getState().pending;
  usePending.setState({ pending: null });
  pending?.resolve(signedIn);
}

/** Mounted once at the root; every Sign in entry point opens this dialog. */
export function ProviderSignInDialogHost() {
  const pending = usePending((state) => state.pending);
  useEffect(() => () => finish(false), []);
  return (
    <OverlayPresence when={pending?.request}>
      {(request) => <ProviderSignInDialog request={request} />}
    </OverlayPresence>
  );
}

function ProviderSignInDialog({ request }: { readonly request: ProviderSignInRequest }) {
  const target = useResolvedProviderSignIn(request);
  const flow = useProviderSignInFlow(target, {
    autoStart: true,
    onSucceeded: () => finish(true),
  });
  // Closing cancels the flow this dialog started; other clients require an explicit Cancel.
  const close = () => {
    if (flow.step.kind !== "elsewhere") void flow.stop();
    finish(false);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle size="sm">
            {request.changeAccount
              ? `Change ${target.providerName} account on ${target.machineName}`
              : providerSignInTitle(target)}
          </DialogTitle>
          <DialogDescription>
            You approve it in your browser on this device. The login stays on {target.machineName}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ProviderSignInFlow target={target} flow={flow}>
            {flow.step.kind === "unsupported" ? (
              <Button size="sm" variant="outline" onClick={close}>
                Close
              </Button>
            ) : null}
          </ProviderSignInFlow>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
