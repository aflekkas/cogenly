import { useEffect, useState } from "react";

import {
  formatProviderBackoff,
  type ProviderBackoff,
} from "@cogenly/client-runtime/state/thread-execution";

/**
 * The backoff status line: "Rate-limited by OpenAI · retrying at 13:41:33
 * (in 4m 12s)". Ticks once a second, but only while a backoff banner is on
 * screen, so an idle thread pays nothing for the countdown.
 */
export function ProviderBackoffTitle(props: { readonly backoff: ProviderBackoff }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return <>{formatProviderBackoff(props.backoff, nowMs)}</>;
}
