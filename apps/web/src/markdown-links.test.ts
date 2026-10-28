import { describe, expect, it } from "vite-plus/test";

import {
  isReplyFileLink,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
} from "./markdown-links";

const cwd = "/Users/me/repo";

const linkIsReplyFile = (href: string) => {
  const meta = resolveMarkdownFileLinkMeta(href, cwd);
  return meta !== null && isReplyFileLink(meta);
};

const inlineCodeIsReplyFile = (code: string) => {
  const meta = resolveInlineCodeFileLinkMeta(code, cwd);
  return meta !== null && isReplyFileLink(meta);
};

describe("isReplyFileLink", () => {
  it("treats a host file outside the workspace as a handed-over file", () => {
    expect(linkIsReplyFile("/Users/me/Downloads/Agreement.pdf")).toBe(true);
    expect(linkIsReplyFile("</Users/me/Downloads/Alex x Davin Agreement.pdf>")).toBe(true);
    expect(linkIsReplyFile("file:///Users/me/Downloads/Report%20Final.docx")).toBe(true);
    expect(linkIsReplyFile("~/Downloads/export.zip")).toBe(true);
  });

  it("keeps code references as path chips", () => {
    expect(linkIsReplyFile("/Users/me/repo/src/index.ts")).toBe(false);
    expect(linkIsReplyFile("src/index.ts")).toBe(false);
    expect(linkIsReplyFile("/Users/me/other/src/index.ts:12")).toBe(false);
  });

  it("leaves images, videos and extensionless paths alone", () => {
    expect(linkIsReplyFile("/Users/me/Downloads/screenshot.png")).toBe(false);
    expect(linkIsReplyFile("/Users/me/Downloads/demo.mp4")).toBe(false);
    expect(linkIsReplyFile("/Users/me/Downloads/output")).toBe(false);
    expect(linkIsReplyFile("/Users/me/.gitignore")).toBe(false);
  });

  it("turns inline code that is exactly one host file path into a handed-over file", () => {
    expect(inlineCodeIsReplyFile("~/Downloads/Agreement.pdf")).toBe(true);
    expect(inlineCodeIsReplyFile("/tmp/report.csv")).toBe(true);
    expect(inlineCodeIsReplyFile("src/report.csv")).toBe(false);
    expect(inlineCodeIsReplyFile("open ~/Downloads/Agreement.pdf")).toBe(false);
  });
});
