import { expect, it } from "vite-plus/test";
import { MUSE_NATIVE_MCP_NOTICE } from "./nativeMcpPolicy.ts";
it("tells turns that Muse cannot suppress its native servers", () => {
  expect(MUSE_NATIVE_MCP_NOTICE).toContain("cannot suppress");
  expect(MUSE_NATIVE_MCP_NOTICE).toContain("Cogenly integration tools");
});
