import {
  formatProviderBackoff,
  type ProviderBackoff,
} from "@cogenly/client-runtime/state/thread-execution";

import { useNowSecond } from "~/hooks/useNowSecond";

/**
 * The backoff status line: "Rate-limited by OpenAI · retrying at 13:41:33
 * (in 4m 12s)". Ticks once a second, but only while a backoff banner is on
 * screen, so an idle thread pays nothing for the countdown.
 */
export function ProviderBackoffTitle(props: { readonly backoff: ProviderBackoff }) {
  const nowMs = useNowSecond();
  return <>{formatProviderBackoff(props.backoff, nowMs)}</>;
}
