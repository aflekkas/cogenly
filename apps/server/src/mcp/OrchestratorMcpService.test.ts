import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  SecretRef,
  VaultError,
  VaultItemId,
  type VaultItemMetadata,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type * as Vault from "../vault/Vault.ts";
import { saveAnswerToVault } from "./OrchestratorMcpService.ts";

const projectId = ProjectId.make("project:secrets");
const ref = SecretRef.make(`secret-ref:${"a".repeat(32)}`);

/** A saved private answer, as SecretRequests stores it when the user saves the card. */
const storedAnswers = () => {
  const values = new Map<string, Uint8Array>([
    [
      `secret-request-${"a".repeat(32)}`,
      new TextEncoder().encode(JSON.stringify({ projectId, value: "typed-token", savedAt: 0 })),
    ],
  ]);
  return Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: (name) => Effect.succeed(Option.fromUndefinedOr(values.get(name))),
    remove: (name) => Effect.sync(() => void values.delete(name)),
    getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes).fill(1)),
  });
};

describe("saveAnswerToVault", () => {
  it.effect("keeps the private answer until the vault write succeeds", () =>
    Effect.gen(function* () {
      const secretRequests = yield* SecretRequests.SecretRequests;
      const saved: Array<string> = [];
      let failNext = true;
      const vault = {
        saveSecretValue: (input: { readonly value: string; readonly name: string }) => {
          if (failNext) {
            failNext = false;
            return Effect.fail(new VaultError({ reason: "storage" }));
          }
          saved.push(input.value);
          return Effect.succeed({
            item: { id: VaultItemId.make("vault:1"), name: input.name } as VaultItemMetadata,
          });
        },
      } as unknown as Vault.Vault["Service"];
      const target = { name: "Token", type: "api_key" as const };

      const first = yield* saveAnswerToVault(secretRequests, vault, {
        ref,
        projectId,
        target,
      }).pipe(Effect.result);
      expect(first._tag).toBe("Failure");

      // A retry still finds the answer, and stores it.
      const item = yield* saveAnswerToVault(secretRequests, vault, { ref, projectId, target });
      expect(item.name).toBe("Token");
      expect(saved).toEqual(["typed-token"]);

      // Stored, the answer is gone.
      const again = yield* saveAnswerToVault(secretRequests, vault, {
        ref,
        projectId,
        target,
      }).pipe(Effect.result);
      expect(again._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        SecretRequests.layer.pipe(
          Layer.provide(storedAnswers()),
          Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
});
