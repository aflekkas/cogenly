import { faviconUrlForOrigin } from "@cogenly/shared/favicon";
import { GlobeIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "../lib/utils";
import { GitHubIcon } from "./Icons";

const SITE_FAVICON_CLASS_NAME = "block size-full shrink-0 select-none";

/** Hosts whose favicon request already failed this session — skip straight to the globe. */
const failedFaviconHosts = new Set<string>();

/** Sites whose brand mark (drawn in `currentColor`) replaces the fetched favicon so it follows the theme. */
function hasBrandMark(host: string): boolean {
  const hostname = host.toLowerCase();
  return hostname === "github.com" || hostname.endsWith(".github.com");
}

/**
 * A website's icon by host: its brand mark, its favicon, or a globe when it
 * has none. Fills its parent, which sets the size.
 */
export const SiteFavicon = memo(function SiteFavicon({ host }: { host: string }) {
  const [failedHost, setFailedHost] = useState<string | null>(null);
  if (hasBrandMark(host)) return <GitHubIcon className={SITE_FAVICON_CLASS_NAME} />;
  const faviconUrl = faviconUrlForOrigin(`https://${host}`);
  if (faviconUrl === null || failedHost === host || failedFaviconHosts.has(host)) {
    return <GlobeIcon className={SITE_FAVICON_CLASS_NAME} />;
  }
  return (
    <img
      src={faviconUrl}
      alt=""
      loading="lazy"
      draggable={false}
      className={cn(SITE_FAVICON_CLASS_NAME, "rounded-sm")}
      onError={() => {
        failedFaviconHosts.add(host);
        setFailedHost(host);
      }}
    />
  );
});
