import { expect, it } from "vite-plus/test";
import { createOutputRedactor } from "./OutputRedactor.ts";

it("redacts credentials across every chunk boundary, newlines, and common encodings", () => {
  const secret = 'client-"secret\nsecond-line';
  const text = `before ${secret} ${encodeURIComponent(secret)} ${JSON.stringify(secret).slice(1, -1)} ${Buffer.from(secret).toString("base64")} after`;
  for (let split = 0; split <= text.length; split++) {
    const redactor = createOutputRedactor([secret]);
    expect(
      redactor.push(text.slice(0, split)) + redactor.push(text.slice(split)) + redactor.flush(),
    ).toBe("before [redacted] [redacted] [redacted] [redacted] after");
  }
});

it("withholds a credential prefix if a process exits partway through printing it", () => {
  const redactor = createOutputRedactor(["secret-client-value"]);
  expect(redactor.push("failure: secret-client") + redactor.flush()).toBe("failure: [redacted]");
});

it("redacts refreshed tokens added after a process starts, including split output", () => {
  const secrets = ["initial-secret"];
  const redactor = createOutputRedactor(() => secrets);
  secrets.push("new-refresh-token");
  const text =
    redactor.push("refreshed new-refresh-") + redactor.push("token done") + redactor.flush();
  expect(text).not.toContain("new-refresh-token");
  expect(text).toContain("[redacted]");
});
