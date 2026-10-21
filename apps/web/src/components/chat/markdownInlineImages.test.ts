import { describe, expect, it } from "vite-plus/test";
import {
  groupInlineImageGalleries,
  inlineImageAspectRatio,
  resolveInlineImageSource,
  withoutPartialTrailingImage,
  type InlineImageHastNode,
} from "./markdownInlineImages";

const text = (value: string): InlineImageHastNode => ({ type: "text", value });
const img = (src: string, alt = ""): InlineImageHastNode => ({
  type: "element",
  tagName: "img",
  properties: { src, alt },
  children: [],
});
const a = (href: string, ...children: InlineImageHastNode[]): InlineImageHastNode => ({
  type: "element",
  tagName: "a",
  properties: { href },
  children,
});
const p = (...children: InlineImageHastNode[]): InlineImageHastNode => ({
  type: "element",
  tagName: "p",
  properties: {},
  children,
});
const root = (...children: InlineImageHastNode[]): InlineImageHastNode => ({
  type: "root",
  children,
});

function galleries(tree: InlineImageHastNode) {
  return (tree.children ?? [])
    .filter((node) => node.properties?.dataMarkdownGallery === true)
    .map((gallery) =>
      (gallery.children ?? []).map((figure) => ({
        caption: figure.properties?.dataCaption,
        src: figure.children?.[0]?.properties?.src,
        source: figure.children?.[1]?.properties?.href ?? null,
        sourceLabel: figure.children?.[1]?.children?.[0]?.value ?? null,
      })),
    );
}

describe("groupInlineImageGalleries", () => {
  it("joins images in one paragraph and in adjacent paragraphs into one row", () => {
    const tree = groupInlineImageGalleries(
      root(
        p(img("https://a.test/1.jpg", "One"), text(" "), img("https://a.test/2.jpg", "Two")),
        text("\n"),
        p(img("https://a.test/3.jpg", "Three")),
        text("\n"),
        p(text("After")),
      ),
    );
    expect(galleries(tree)).toEqual([
      [
        { caption: "One", src: "https://a.test/1.jpg", source: null, sourceLabel: null },
        { caption: "Two", src: "https://a.test/2.jpg", source: null, sourceLabel: null },
        { caption: "Three", src: "https://a.test/3.jpg", source: null, sourceLabel: null },
      ],
    ]);
    expect(tree.children?.map((node) => node.tagName ?? node.type)).toEqual(["div", "text", "p"]);
    expect(tree.children?.[0]?.properties?.dataGalleryCount).toBe(3);
  });

  it("credits a following link or a wrapping link as the image's source", () => {
    const tree = groupInlineImageGalleries(
      root(
        p(
          img("https://a.test/tower.jpg", "Eiffel Tower"),
          text(" — Source: "),
          a("https://en.wikipedia.org/wiki/Eiffel_Tower", text("Wikipedia")),
          text("\n"),
          a("https://www.example.com/page", img("https://a.test/arc.jpg", "Arc")),
        ),
      ),
    );
    expect(galleries(tree)).toEqual([
      [
        {
          caption: "Eiffel Tower",
          src: "https://a.test/tower.jpg",
          source: "https://en.wikipedia.org/wiki/Eiffel_Tower",
          sourceLabel: "Wikipedia",
        },
        {
          caption: "Arc",
          src: "https://a.test/arc.jpg",
          source: "https://www.example.com/page",
          sourceLabel: "example.com",
        },
      ],
    ]);
  });

  it("leaves images that share a paragraph with text, and local images, inline", () => {
    const sentence = p(text("Here it is: "), img("https://a.test/1.jpg"));
    const local = p(img("./screenshot.png"));
    const tree = groupInlineImageGalleries(root(sentence, local));
    expect(tree.children).toEqual([sentence, local]);
  });

  it("starts a new row after anything that is not an image paragraph", () => {
    const tree = groupInlineImageGalleries(
      root(p(img("https://a.test/1.jpg")), p(text("Between")), p(img("https://a.test/2.jpg"))),
    );
    expect(galleries(tree).map((row) => row.length)).toEqual([1, 1]);
  });

  it("groups inside list items and blockquotes", () => {
    const item: InlineImageHastNode = {
      type: "element",
      tagName: "li",
      children: [p(img("https://a.test/1.jpg")), p(img("https://a.test/2.jpg"))],
    };
    groupInlineImageGalleries(root(item));
    expect(galleries(item).map((row) => row.length)).toEqual([2]);
  });
});

describe("resolveInlineImageSource", () => {
  const proxyUrl = (url: string) =>
    `https://app.test/api/image-proxy?url=${encodeURIComponent(url)}`;

  it("loads third-party https images through the proxy, then directly", () => {
    expect(resolveInlineImageSource("https://cdn.test/a.png", { proxyUrl })).toEqual({
      kind: "remote",
      url: "https://cdn.test/a.png",
      candidates: [
        "https://app.test/api/image-proxy?url=https%3A%2F%2Fcdn.test%2Fa.png",
        "https://cdn.test/a.png",
      ],
    });
  });

  it("loads directly without a proxy or from the app's own origin", () => {
    expect(resolveInlineImageSource("https://cdn.test/a.png")).toMatchObject({
      candidates: ["https://cdn.test/a.png"],
    });
    expect(
      resolveInlineImageSource("https://app.test/a.png", {
        proxyUrl,
        firstPartyOrigins: ["https://app.test"],
      }),
    ).toMatchObject({ candidates: ["https://app.test/a.png"] });
    expect(resolveInlineImageSource("//cdn.test/a.png")).toMatchObject({
      candidates: ["https://cdn.test/a.png"],
    });
  });

  it("never loads plain http and ignores non-web sources", () => {
    expect(resolveInlineImageSource("http://cdn.test/a.png", { proxyUrl })).toEqual({
      kind: "blocked",
      url: "http://cdn.test/a.png",
    });
    expect(resolveInlineImageSource("data:image/png;base64,AAAA")).toBeNull();
    expect(resolveInlineImageSource("./a.png")).toBeNull();
  });
});

describe("inlineImageAspectRatio", () => {
  it("uses the authored size, else 4:3", () => {
    expect(inlineImageAspectRatio("1600", 900)).toBeCloseTo(16 / 9);
    expect(inlineImageAspectRatio(undefined, 900)).toBeCloseTo(4 / 3);
    expect(inlineImageAspectRatio("wide", "0")).toBeCloseTo(4 / 3);
  });
});

describe("withoutPartialTrailingImage", () => {
  it("holds back an image until its markdown is complete", () => {
    expect(withoutPartialTrailingImage("Look:\n\n![Eiffel")).toBe("Look:\n\n");
    expect(withoutPartialTrailingImage("Look:\n\n![Eiffel Tower](https://exa")).toBe("Look:\n\n");
    expect(withoutPartialTrailingImage("A ![b](https://x.test/b.png) ![c](https://x")).toBe(
      "A ![b](https://x.test/b.png)",
    );
    expect(withoutPartialTrailingImage("[![a](https://x.test/a.png)](https://ex")).toBe("");
  });

  it("keeps complete images and code", () => {
    const complete = "![a](https://x.test/a.png)";
    expect(withoutPartialTrailingImage(complete)).toBe(complete);
    const linked = "[![a](https://x.test/a.png)](https://x.test)";
    expect(withoutPartialTrailingImage(linked)).toBe(linked);
    const fenced = "```md\n![a](https://x";
    expect(withoutPartialTrailingImage(fenced)).toBe(fenced);
    const inlineCode = "Use `![a](https://x";
    expect(withoutPartialTrailingImage(inlineCode)).toBe(inlineCode);
  });
});
