// @effect-diagnostics nodeBuiltinImport:off -- isolated document parser runtime boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { SaxesParser } from "saxes";
import { characterEntities } from "character-entities";
import * as Yauzl from "yauzl";

const MAX_INPUT = 16 * 1024 * 1024;
const MAX_EXPANDED = 24 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const TRUNCATED = "\n[Document text truncated.]";
class LimitReached extends Error {}
interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: Array<XmlNode | string>;
}

function xml(source: string, html = false): XmlNode {
  const root: XmlNode = { name: "root", attrs: {}, children: [] };
  const stack = [root];
  let count = 0;
  const parser = new SaxesParser();
  if (html) Object.assign(parser.ENTITIES, characterEntities);
  parser.on("opentag", (tag) => {
    if (++count > 150_000 || stack.length >= 100) throw new LimitReached();
    const node: XmlNode = {
      name: tag.name.split(":").at(-1)!,
      attrs: Object.fromEntries(
        Object.entries(tag.attributes).flatMap(([key, value]) => [
          [key, String(value)],
          [key.split(":").at(-1)!, String(value)],
        ]),
      ),
      children: [],
    };
    stack.at(-1)!.children.push(node);
    stack.push(node);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  const text = (value: string) => {
    stack.at(-1)!.children.push(value);
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.write(source).close();
  return root;
}
function* nodes(node: XmlNode, name: string): Generator<XmlNode> {
  for (const child of node.children)
    if (typeof child !== "string") {
      if (child.name === name) yield child;
      else yield* nodes(child, name);
    }
}
function* text(node: XmlNode): Generator<string> {
  if (["script", "style", "binary-data", "rPh"].includes(node.name)) return;
  if (["tab", "cell"].includes(node.name)) yield "\t";
  else if (["br", "line-break", "cr"].includes(node.name)) yield "\n";
  else if (node.name === "s") {
    const count = Number(node.attrs.c ?? 1);
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_OUTPUT) throw new LimitReached();
    yield " ".repeat(count);
  } else {
    for (const child of node.children) yield* typeof child === "string" ? [child] : text(child);
    if (
      ["p", "h", "div", "li", "tr", "table-row"].includes(node.name) ||
      /^h[1-6]$/.test(node.name)
    )
      yield "\n";
    if (["tc", "td", "th", "table-cell"].includes(node.name)) yield "\t";
  }
}
const value = (node: XmlNode) => [...text(node)].join("").trim();

async function archive(path: string) {
  const zip = await new Promise<Yauzl.ZipFile>((resolve, reject) =>
    Yauzl.open(
      path,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => (error || !zip ? reject(error) : resolve(zip)),
    ),
  );
  const files = new Map<string, string>();
  let expanded = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: Yauzl.Entry) => {
        if (zip.entryCount > 2048 || entry.generalPurposeBitFlag & 1) {
          reject(new Error("Unsupported archive"));
          return;
        }
        if (!/\.(xml|rels|xhtml|html|htm|opf)$/i.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        expanded += entry.uncompressedSize;
        if (
          expanded > MAX_EXPANDED ||
          entry.uncompressedSize > Math.max(1024, entry.compressedSize * 200)
        ) {
          reject(new Error("Archive expansion limit"));
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error);
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("error", reject);
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > entry.uncompressedSize || size > MAX_EXPANDED) {
              stream.destroy(new Error("Entry limit"));
              return;
            }
            chunks.push(chunk);
          });
          stream.on("end", () => {
            const data = Buffer.concat(chunks);
            const encoding =
              (data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0x3c && data[1] === 0)
                ? "utf-16le"
                : (data[0] === 0xfe && data[1] === 0xff) || (data[0] === 0 && data[1] === 0x3c)
                  ? "utf-16be"
                  : "utf-8";
            files.set(entry.fileName, new TextDecoder(encoding).decode(data));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return files;
}

function* notebook(source: string): Generator<string> {
  const book: unknown = JSON.parse(source);
  if (!book || typeof book !== "object" || !("cells" in book) || !Array.isArray(book.cells))
    throw new Error("Invalid notebook");
  const lines = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((line): line is string => typeof line === "string")
        : [];
  for (const [index, cell] of book.cells.entries()) {
    if (index >= 10_000) throw new LimitReached();
    if (!cell || typeof cell !== "object") continue;
    yield `## Cell ${index + 1} (${"cell_type" in cell ? cell.cell_type : "unknown"})\n`;
    if ("source" in cell) yield* lines(cell.source);
    if ("outputs" in cell && Array.isArray(cell.outputs))
      for (const output of cell.outputs) {
        if (!output || typeof output !== "object") continue;
        yield "\n";
        if ("text" in output) yield* lines(output.text);
        else if (
          "data" in output &&
          output.data &&
          typeof output.data === "object" &&
          "text/plain" in output.data
        )
          yield* lines(output.data["text/plain"]);
        else if ("traceback" in output)
          for (const line of lines(output.traceback))
            yield NodeUtil.stripVTControlCharacters(line) + "\n";
      }
    yield "\n\n";
  }
}

async function* document(path: string): AsyncGenerator<string> {
  if ((await NodeFSP.stat(path)).size > MAX_INPUT) throw new Error("Input limit");
  const extension = NodePath.extname(path).toLowerCase();
  if (extension === ".ipynb") {
    yield* notebook(await NodeFSP.readFile(path, "utf8"));
    return;
  }
  const files = await archive(path);
  const read = (name: string) => {
    const source = files.get(name);
    if (!source) throw new Error("Missing document part");
    return xml(source, extension === ".epub");
  };
  const relations = (name: string) =>
    new Map(
      [...nodes(read(name), "Relationship")]
        .filter((rel) => rel.attrs.TargetMode !== "External")
        .map((rel) => [rel.attrs.Id, rel.attrs.Target!]),
    );
  const targetPath = (base: string, target: string) =>
    target.startsWith("/")
      ? target.slice(1)
      : NodePath.posix.normalize(NodePath.posix.join(base, target));
  if (extension === ".docx") yield* text(read("word/document.xml"));
  else if (extension === ".odt") yield* text(read("content.xml"));
  else if (extension === ".xlsx") {
    const strings = files.has("xl/sharedStrings.xml")
      ? [...nodes(read("xl/sharedStrings.xml"), "si")].map(value)
      : [];
    const rels = relations("xl/_rels/workbook.xml.rels");
    for (const sheet of nodes(read("xl/workbook.xml"), "sheet")) {
      yield `\n## Sheet: ${sheet.attrs.name}\n`;
      const target = rels.get(sheet.attrs["r:id"] ?? sheet.attrs.id);
      if (!target) throw new Error("Missing sheet relationship");
      for (const row of nodes(read(targetPath("xl", target)), "row")) {
        let column = 0;
        for (const cell of nodes(row, "c")) {
          const letters = cell.attrs.r?.match(/^[A-Z]+/)?.[0];
          const next = letters
            ? [...letters].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1
            : column;
          if (next > 512) throw new LimitReached();
          if (column) yield "\t";
          yield "\t".repeat(Math.max(0, next - column));
          const raw = [...nodes(cell, "v")].map(value).join("");
          yield cell.attrs.t === "s"
            ? (strings[Number(raw)] ?? "")
            : cell.attrs.t === "inlineStr"
              ? value(cell)
              : raw || [...nodes(cell, "f")].map(value).join("");
          column = next + 1;
        }
        yield "\n";
      }
    }
  } else if (extension === ".pptx") {
    const rels = relations("ppt/_rels/presentation.xml.rels");
    let index = 0;
    for (const slide of nodes(read("ppt/presentation.xml"), "sldId")) {
      const target = rels.get(slide.attrs["r:id"] ?? slide.attrs.id);
      if (!target) throw new Error("Missing slide relationship");
      yield `\n## Slide ${++index}\n`;
      const name = targetPath("ppt", target);
      yield* text(read(name));
      const relPath = NodePath.posix.join(
        NodePath.posix.dirname(name),
        "_rels",
        `${NodePath.posix.basename(name)}.rels`,
      );
      if (files.has(relPath))
        for (const rel of nodes(read(relPath), "Relationship")) {
          if (
            rel.attrs.Type?.endsWith("/notesSlide") &&
            rel.attrs.TargetMode !== "External" &&
            rel.attrs.Target
          ) {
            yield "\nNotes:\n";
            yield* text(read(targetPath(NodePath.posix.dirname(name), rel.attrs.Target)));
          }
        }
    }
  } else if (extension === ".epub") {
    const root = [...nodes(read("META-INF/container.xml"), "rootfile")][0]?.attrs["full-path"];
    if (!root) throw new Error("Missing EPUB package");
    const pkg = read(root);
    const items = new Map([...nodes(pkg, "item")].map((item) => [item.attrs.id, item.attrs.href!]));
    let index = 0;
    for (const item of nodes(pkg, "itemref")) {
      const href = items.get(item.attrs.idref);
      if (!href) throw new Error("Missing chapter");
      yield `\n## Chapter ${++index}\n`;
      yield* text(
        read(targetPath(NodePath.posix.dirname(root), decodeURIComponent(href.split("#")[0]!))),
      );
    }
  } else throw new Error("Unsupported document");
}

/** Runs only in the parser subprocess; budgets include raw whitespace and UTF-8 bytes. */
export async function extractDocumentText(path: string): Promise<string> {
  const chunks: string[] = [];
  let remaining = MAX_OUTPUT - Buffer.byteLength(TRUNCATED);
  let truncated = false;
  try {
    for await (const part of document(path)) {
      const bytes = Buffer.from(part.replaceAll("\0", ""));
      if (bytes.length > remaining) {
        // Fatal decoding drops an incomplete final code point instead of introducing replacement text.
        let end = remaining;
        while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
        chunks.push(bytes.subarray(0, end).toString("utf8"));
        throw new LimitReached();
      }
      remaining -= bytes.length;
      chunks.push(part.replaceAll("\0", ""));
      if (remaining === 0) throw new LimitReached();
    }
  } catch (error) {
    if (!(error instanceof LimitReached)) throw error;
    truncated = true;
  }
  const result = chunks
    .join("")
    .replaceAll(/\n(?:[ \t]*\n){2,}/g, "\n\n")
    .trim();
  if (!result && !truncated) throw new Error("No document text");
  return result + (truncated ? TRUNCATED : "");
}
