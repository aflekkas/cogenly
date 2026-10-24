// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { describe, expect, it } from "vite-plus/test";

import { makePinnedFetch } from "./outboundHttp.ts";

describe("makePinnedFetch", () => {
  it("connects to the pinned address, keeping the URL's host for the Host header", async () => {
    const hosts: Array<string | undefined> = [];
    const server = NodeHttp.createServer((request, response) => {
      hosts.push(request.headers.host);
      response.end("pinned");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as NodeNet.AddressInfo;
    // `.invalid` never resolves, so only the pin can reach the server.
    const pinned = makePinnedFetch([{ address: "127.0.0.1", family: 4 }]);
    try {
      const response = await pinned.fetch(`http://images.invalid:${port}/a.png`);
      expect(await response.text()).toBe("pinned");
      expect(hosts).toEqual([`images.invalid:${port}`]);
    } finally {
      await pinned.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
