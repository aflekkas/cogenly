import { expect, it } from "vite-plus/test";
import { museNativeMcpNotice } from "./nativeMcpPolicy.ts";
it("reports unsupported isolation to turns and honors the native-config off switch", () => {
  expect(museNativeMcpNotice()).toContain("cannot suppress");
  expect(museNativeMcpNotice(false)).toContain("Cogenly integration tools");
  expect(museNativeMcpNotice(true)).toBeUndefined();
});
