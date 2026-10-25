import { GrokDriver, type GrokDriverEnv } from "@cogenly/provider-grok/server";
import { MuseDriver, type MuseDriverEnv } from "@cogenly/provider-muse/server";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import type {
  AnyProviderDriver,
  ProviderUsageReaderEnv,
} from "@cogenly/provider-core/server/driver";

export type BuiltInDriversEnv = ClaudeDriverEnv | CodexDriverEnv | MuseDriverEnv | GrokDriverEnv;

// Stored instances with other driver kinds remain unavailable history.
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  CodexDriver,
  ClaudeDriver,
  MuseDriver,
  GrokDriver,
];
export type BuiltInUsageReadersEnv =
  | ProviderUsageReaderEnv<typeof ClaudeDriver>
  | ProviderUsageReaderEnv<typeof CodexDriver>
  | ProviderUsageReaderEnv<typeof MuseDriver>;
// Grok keeps no readable usage history yet; its turns still report usage live.
export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<
  AnyProviderDriver<BuiltInDriversEnv, BuiltInUsageReadersEnv>
> = [ClaudeDriver, CodexDriver, MuseDriver, GrokDriver];
