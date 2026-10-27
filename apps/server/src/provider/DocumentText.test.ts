// @effect-diagnostics nodeBuiltinImport:off -- real parser fixtures and subprocess integration.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChatAttachmentId, type ChatAttachment } from "@cogenly/contracts";
import { providerMessageTextWithAttachmentPaths } from "@cogenly/provider-core/server/attachmentPrompt";
import * as ServerConfig from "../config.ts";
import {
  createPendingAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentTextPath,
} from "../attachmentStore.ts";
import {
  claimPendingAttachments,
  releaseClaimedAttachments,
} from "../orchestration-v2/AttachmentClaims.ts";
import { appendUserInputAttachmentPaths } from "./userInputAttachments.ts";
import { extractDocumentText } from "./documentTextWorker.ts";
import * as DocumentText from "./DocumentText.ts";

// Store-only ZIPs keep document fixtures legible and independent of an Office installation.
function zip(files: Record<string, string>) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, source] of Object.entries(files)) {
    const path = Buffer.from(name),
      data = Buffer.from(source);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(NodeZlib.crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(path.length, 26);
    local.push(header, path, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(NodeZlib.crc32(data), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(path.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, path);
    offset += header.length + path.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const relation = (id: string, target: string) =>
  `<Relationships><Relationship Id="${id}" Target="${target}"/></Relationships>`;
const fixtures = [
  {
    extension: "docx",
    files: {
      "word/document.xml":
        '<w:document xmlns:w="word"><w:p><w:r><w:t>Office &amp; text</w:t></w:r></w:p></w:document>',
    },
    expected: "Office & text",
  },
  {
    extension: "odt",
    files: { "content.xml": "<document><p>Open document</p></document>" },
    expected: "Open document",
  },
  {
    extension: "xlsx",
    files: {
      "xl/workbook.xml": '<workbook><sheet name="Budget" id="s1"/></workbook>',
      "xl/_rels/workbook.xml.rels": relation("s1", "worksheets/sheet1.xml"),
      "xl/sharedStrings.xml": "<sst><si><t>Revenue</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><row><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42</v></c></row></worksheet>',
    },
    expected: "Revenue\t\t42",
  },
  {
    extension: "pptx",
    files: {
      "ppt/presentation.xml":
        '<presentation xmlns:r="relations"><sldId r:id="slide2" id="258"/><sldId r:id="slide1" id="257"/></presentation>',
      "ppt/_rels/presentation.xml.rels":
        '<Relationships><Relationship Id="slide1" Target="slides/slide1.xml"/><Relationship Id="slide2" Target="slides/slide2.xml"/></Relationships>',
      "ppt/slides/slide1.xml": "<slide><p><t>First file</t></p></slide>",
      "ppt/slides/slide2.xml": "<slide><p><t>First slide</t></p></slide>",
    },
    expected: "## Slide 1\nFirst slide",
  },
  {
    extension: "epub",
    files: {
      "META-INF/container.xml": '<container><rootfile full-path="book/package.opf"/></container>',
      "book/package.opf":
        '<package><manifest><item id="c" href="chapter.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>',
      "book/chapter.xhtml":
        "<html><body><h1>A &copy; book</h1><script>hidden</script><p>Chapter text</p></body></html>",
    },
    expected: "A © book",
  },
];

describe("document text", () => {
  it.each(fixtures)("reads $extension in document order", async (fixture) => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cogenly-document-"));
    try {
      const path = NodePath.join(dir, `document.${fixture.extension}`);
      await NodeFSP.writeFile(path, zip(fixture.files));
      const text = await extractDocumentText(path);
      expect(text).toContain(fixture.expected);
      expect(text).not.toContain("hidden");
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
  it.effect(
    "claims a notebook, exposes its sidecar in messages and answers, and rolls both back",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const id = createPendingAttachmentId("ipynb");
        const content = JSON.stringify({
          cells: [
            {
              cell_type: "code",
              source: ["print(42)"],
              outputs: [{ data: { "text/plain": ["42"], "image/png": "BINARY" } }],
            },
          ],
        });
        const attachment: ChatAttachment = {
          type: "file",
          id: ChatAttachmentId.make(id),
          name: "analysis.ipynb",
          mimeType: "application/json",
          sizeBytes: Buffer.byteLength(content),
        };
        const pending = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment,
        })!;
        yield* fs.writeFileString(pending, content);
        const claimed = yield* claimPendingAttachments({
          threadId: "thread-doc",
          attachments: [attachment],
        });
        const path = claimed.claimedPaths[0]!;
        expect(yield* fs.readFileString(`${path}.txt`)).toContain("print(42)");
        expect(yield* fs.readFileString(`${path}.txt`)).not.toContain("BINARY");
        expect(yield* fs.exists(`${pending}.txt`)).toBe(false);
        const resolve = (attachment: (typeof claimed.attachments)[number]) =>
          resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
        const text = providerMessageTextWithAttachmentPaths({
          text: "Read this",
          attachments: claimed.attachments,
          resolveAttachmentPath: resolve,
          resolveAttachmentTextPath: (attachment) =>
            resolveAttachmentTextPath({ attachmentsDir: config.attachmentsDir, attachment }),
        });
        expect(text).toContain(`extracted text: ${path}.txt`);
        const answers = yield* appendUserInputAttachmentPaths({
          answers: {},
          attachmentsDir: config.attachmentsDir,
          attachmentsByQuestionId: { q: [{ ...claimed.attachments[0]!, type: "file" }] },
        });
        expect(answers.q).toContain(`${path}.txt`);
        yield* releaseClaimedAttachments(claimed.claimedPaths);
        expect(yield* fs.exists(path)).toBe(false);
        expect(yield* fs.exists(`${path}.txt`)).toBe(false);
        expect(yield* fs.exists(pending)).toBe(true);
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "cogenly-document-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );
  it.effect("skips unsupported or corrupt inputs without publishing a sidecar", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const documents = yield* DocumentText.DocumentText;
      const path = NodePath.join(dir, "bad.docx");
      yield* fs.writeFileString(path, "not a zip");
      expect(yield* documents.ensure(path)).toBeUndefined();
      expect(yield* fs.exists(`${path}.txt`)).toBe(false);
      expect(yield* documents.ensure(NodePath.join(dir, "plain.txt"))).toBeUndefined();
    }).pipe(
      Effect.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.scoped,
    ),
  );
  it("caps UTF-8 output and marks truncation", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cogenly-document-"));
    try {
      const path = NodePath.join(dir, "large.ipynb");
      await NodeFSP.writeFile(path, JSON.stringify({ cells: [{ source: "🙂".repeat(400_000) }] }));
      const text = await extractDocumentText(path);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024 * 1024);
      expect(text).toContain("[Document text truncated.]");
      expect(text).not.toContain("�");
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
