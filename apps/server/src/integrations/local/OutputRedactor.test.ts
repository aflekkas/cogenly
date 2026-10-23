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
