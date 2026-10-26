import type { AssetResource, EnvironmentId } from "@cogenly/contracts";
import { faviconUrlForOrigin } from "@cogenly/shared/favicon";
import { isProjectFaviconFallbackUrl } from "@cogenly/shared/projectFavicon";
import { GlobeIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { useAssetUrlState } from "../assets/assetUrls";
import { cn } from "../lib/utils";
import { GitHubIcon } from "./Icons";

const SITE_FAVICON_CLASS_NAME = "block size-full shrink-0 select-none";

/** Image URLs whose request already failed this session — skip straight to the next choice. */
const failedFaviconUrls = new Set<string>();

/** Sites whose brand mark (drawn in `currentColor`) replaces the fetched favicon so it follows the theme. */
function hasBrandMark(host: string): boolean {
  const hostname = host.toLowerCase();
  return hostname === "github.com" || hostname.endsWith(".github.com");
}

/**
 * A website's icon by host: its brand mark, the icon `environmentId`'s server
 * cached for it (vault logins: the agent's choice or the site's favicon),
 * the public favicon, or a globe when it has none. Fills its parent, which
 * sets the size.
 */
export const SiteFavicon = memo(function SiteFavicon({
  host,
  environmentId = null,
}: {
  readonly host: string;
  readonly environmentId?: EnvironmentId | null;
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const resource = useMemo<AssetResource | null>(
    () => (environmentId === null || hasBrandMark(host) ? null : { _tag: "site-icon", host }),
    [environmentId, host],
  );
  const cached = useAssetUrlState(environmentId, resource);
  if (hasBrandMark(host)) return <GitHubIcon className={SITE_FAVICON_CLASS_NAME} />;
  const cachedUrl =
    cached._tag === "Success" && !isProjectFaviconFallbackUrl(cached.url) ? cached.url : null;
  const url = [cachedUrl, faviconUrlForOrigin(`https://${host}`)].find(
    (candidate): candidate is string =>
      candidate !== null && !failed.has(candidate) && !failedFaviconUrls.has(candidate),
  );
  if (url === undefined) return <GlobeIcon className={SITE_FAVICON_CLASS_NAME} />;
  return (
    <img
      key={url}
      src={url}
      alt=""
      loading="lazy"
      draggable={false}
      className={cn(SITE_FAVICON_CLASS_NAME, "rounded-sm")}
      onError={() => {
        failedFaviconUrls.add(url);
        setFailed((current) => new Set(current).add(url));
      }}
    />
  );
});
