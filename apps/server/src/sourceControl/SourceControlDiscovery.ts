import {
  type SourceControlDiscoveryResult,
  type VcsDiscoveryItem,
  type VcsDriverKind,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { detailFromCause, firstNonEmptyLine } from "@cogenly/source-control-core/server/discovery";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

interface VcsProbe {
  readonly kind: VcsDriverKind;
  readonly label: string;
  readonly executable: string;
  readonly versionArgs: ReadonlyArray<string>;
  readonly installHint: string;
}

const VCS_PROBES: ReadonlyArray<VcsProbe> = [
  {
    kind: "git",
    label: "Git",
    executable: "git",
    versionArgs: ["--version"],
    installHint: "Install Git from https://git-scm.com/downloads or with your package manager.",
  },
];

export class SourceControlDiscovery extends Context.Service<
  SourceControlDiscovery,
  {
    readonly discover: Effect.Effect<SourceControlDiscoveryResult>;
  }
>()("cogenly-server/sourceControl/SourceControlDiscovery") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const process = yield* VcsProcess.VcsProcess;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const probe = (input: VcsProbe): Effect.Effect<VcsDiscoveryItem> =>
    process
      .run({
        operation: "source-control.discovery.probe",
        command: input.executable,
        args: input.versionArgs,
        cwd: config.cwd,
        timeoutMs: 5_000,
        maxOutputBytes: 8_000,
        appendTruncationMarker: true,
      })
      .pipe(
        Effect.map(
          (result) =>
            ({
              kind: input.kind,
              label: input.label,
              executable: input.executable,
              status: "available" as const,
              version: Option.orElse(firstNonEmptyLine(result.stdout), () =>
                firstNonEmptyLine(result.stderr),
              ),
              installHint: input.installHint,
              detail: Option.none<string>(),
            }) satisfies VcsDiscoveryItem,
        ),
        Effect.catch((cause) =>
          Effect.succeed({
            kind: input.kind,
            label: input.label,
            executable: input.executable,
            status: "missing" as const,
            version: Option.none<string>(),
            installHint: input.installHint,
            detail: detailFromCause(cause),
          } satisfies VcsDiscoveryItem),
        ),
      );

  return SourceControlDiscovery.of({
    discover: Effect.all({
      versionControlSystems: Effect.all(VCS_PROBES.map(probe), { concurrency: "unbounded" }),
      sourceControlProviders: sourceControlProviders.discover,
    }),
  });
});

export const layer = Layer.effect(SourceControlDiscovery, make);
