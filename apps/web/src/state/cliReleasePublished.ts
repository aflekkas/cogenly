import { useAtomValue } from "@effect/atom-react";
import { cliReleaseTagApiUrl } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

/**
 * Whether the GitHub release for `version` is published, which is where
 * self-updating servers download their archive from. A 404 or a draft is
 * false; network and API errors stay unknown. Both re-check every few
 * minutes, so a release that lands later shows up without a reload.
 */
export const cliReleasePublishedAtom = Atom.family((version: string) =>
  Atom.make(
    Effect.gen(function* () {
      const url = cliReleaseTagApiUrl(version);
      if (url === null) return false;
      const response = yield* HttpClient.get(url);
      if (response.status === 404) return false;
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
      );
      return (
        typeof body === "object" &&
        body !== null &&
        "tag_name" in body &&
        body.tag_name === `v${version}` &&
        !("draft" in body && body.draft === true)
      );
    }).pipe(
      // Tracing headers would make the browser send a CORS preflight.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`cli-release-published:${version}`),
  ),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("cli-release-published:none"),
);

/** True only once GitHub confirms the release, so callers can hide work that
    would download it until then. */
export function useCliReleasePublished(version: string | null): boolean {
  const result = useAtomValue(version ? cliReleasePublishedAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}
