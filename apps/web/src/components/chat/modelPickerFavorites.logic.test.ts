import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { modelPickerModelKey } from "./modelPickerKeys";
import { orderModelPickerFavorites } from "./modelPickerFavorites.logic";

const codex = ProviderInstanceId.make("codex");
const claudePersonal = ProviderInstanceId.make("claude_personal");
const claude = ProviderInstanceId.make("claude");
const muse = ProviderInstanceId.make("muse");

const model = (instanceId: ProviderInstanceId, slug: string) => ({ instanceId, slug });

// Catalog order per provider, grouped by provider in an order unlike the rail's.
const models = [
  model(muse, "muse-wonder-full-1.0"),
  model(claude, "claude-opus-5-5"),
  model(claude, "claude-sonnet-5"),
  model(codex, "gpt-6.1-sol"),
  model(codex, "gpt-6-astra"),
  model(claudePersonal, "claude-opus-5-5"),
];

const keysOf = (...items: ReadonlyArray<{ instanceId: ProviderInstanceId; slug: string }>) =>
  new Set(items.map((item) => modelPickerModelKey(item.instanceId, item.slug)));

const slugsOf = (items: ReadonlyArray<{ instanceId: ProviderInstanceId; slug: string }>) =>
  items.map((item) => `${item.instanceId}/${item.slug}`);

describe("orderModelPickerFavorites", () => {
  const rail = [codex, claudePersonal, claude, muse].map((instanceId) => ({ instanceId }));

  it("follows the rail's provider order, then each provider's catalog order", () => {
    // Starred in this order: Astra before Sol, Muse before Claude.
    const favoriteKeys = keysOf(
      model(claudePersonal, "claude-opus-5-5"),
      model(muse, "muse-wonder-full-1.0"),
      model(codex, "gpt-6-astra"),
      model(claude, "claude-opus-5-5"),
      model(codex, "gpt-6.1-sol"),
    );
    expect(
      slugsOf(orderModelPickerFavorites({ models, favoriteKeys, instanceOrder: rail })),
    ).toEqual([
      "codex/gpt-6.1-sol",
      "codex/gpt-6-astra",
      "claude_personal/claude-opus-5-5",
      "claude/claude-opus-5-5",
      "muse/muse-wonder-full-1.0",
    ]);
  });

  it("reorders when the providers are reordered", () => {
    const favoriteKeys = keysOf(model(codex, "gpt-6.1-sol"), model(muse, "muse-wonder-full-1.0"));
    const reordered = [muse, codex, claude, claudePersonal].map((instanceId) => ({ instanceId }));
    expect(
      slugsOf(orderModelPickerFavorites({ models, favoriteKeys, instanceOrder: reordered })),
    ).toEqual(["muse/muse-wonder-full-1.0", "codex/gpt-6.1-sol"]);
  });

  it("drops stars the picker cannot offer and puts unranked providers last", () => {
    const favoriteKeys = keysOf(
      model(codex, "gone-model"),
      model(claude, "claude-sonnet-5"),
      model(muse, "muse-wonder-full-1.0"),
    );
    expect(
      slugsOf(
        orderModelPickerFavorites({ models, favoriteKeys, instanceOrder: [{ instanceId: muse }] }),
      ),
    ).toEqual(["muse/muse-wonder-full-1.0", "claude/claude-sonnet-5"]);
  });
});
