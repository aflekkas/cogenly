import { matchers, routes, type Transform, type VercelConfig } from "@vercel/config/v1";

// Cogenly has no hosted web deployment. These hosts are unset by default; a
// deployment that wants the channel router must provide its own.
const ROUTER_HOST = process.env.COGENLY_HOSTED_ROUTER_HOST?.trim() ?? "";
const HOSTED_WEB_CHANNEL_COOKIE = "cogenly_web_channel";
const LATEST_ORIGIN = process.env.COGENLY_HOSTED_LATEST_ORIGIN?.trim() ?? "";
const NIGHTLY_ORIGIN = process.env.COGENLY_HOSTED_NIGHTLY_ORIGIN?.trim() ?? "";
const HAS_CHANNEL_ROUTER = ROUTER_HOST !== "" && LATEST_ORIGIN !== "" && NIGHTLY_ORIGIN !== "";
const CLEAN_CHANNEL_QUERY_TRANSFORMS = [
  {
    type: "request.query",
    op: "delete",
    target: { key: "channel" },
  },
] satisfies Transform[];

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export const config: VercelConfig = {
  buildCommand:
    'vp run --filter @cogenly/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@cogenly/scripts...' --filter '@cogenly/web...'",
  routes: [
    {
      src: "/__cogenly/channel",
      has: [matchers.query("channel", "nightly")],
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("nightly"),
      },
      status: 302,
    },
    {
      src: "/__cogenly/channel",
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("latest"),
      },
      status: 302,
    },
    ...(HAS_CHANNEL_ROUTER
      ? [
          {
            src: "/(.*)",
            has: [
              matchers.host(ROUTER_HOST),
              matchers.cookie(HOSTED_WEB_CHANNEL_COOKIE, "nightly"),
            ],
            dest: `${NIGHTLY_ORIGIN}/$1`,
          },
          {
            src: "/(.*)",
            has: [matchers.host(ROUTER_HOST)],
            dest: `${LATEST_ORIGIN}/$1`,
          },
        ]
      : []),
  ],
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
};
