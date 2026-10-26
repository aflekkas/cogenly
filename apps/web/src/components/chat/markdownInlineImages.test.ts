import { describe, expect, it } from "vite-plus/test";
import {
  groupInlineImageGalleries,
  imageProxyUrl,
  inlineImageAspectRatio,
  remoteImageAssetResource,
  resolveInlineImageSource,
  resolveRemoteImageSrc,
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

const em = (...children: InlineImageHastNode[]): InlineImageHastNode => ({
  type: "element",
  tagName: "em",
  properties: {},
  children,
});
const li = (...children: InlineImageHastNode[]): InlineImageHastNode => ({
  type: "element",
  tagName: "li",
  properties: {},
  children,
});

function plain(node: InlineImageHastNode): string {
  // Copy-hidden separators render as " · " but are not authored text.
  if (node.properties?.dataMarkdownCopy !== undefined) return " · ";
  return node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(plain).join("");
}

function galleries(tree: InlineImageHastNode) {
  return (tree.children ?? [])
    .filter((node) => node.properties?.dataMarkdownGallery === true)
    .map((gallery) =>
      (gallery.children ?? []).map((figure) => {
        const [image, ...caption] = figure.children ?? [];
        const sourceLink = caption.find((node) => node.tagName === "a");
        return {
          caption: figure.properties?.dataCaption,
          src: image?.properties?.src,
          source: sourceLink?.properties?.href ?? null,
          sourceLabel: sourceLink ? plain(sourceLink) : null,
        };
      }),
    );
}

function captionText(tree: InlineImageHastNode): string[] {
  return galleries(tree).length === 0
    ? []
    : (tree.children ?? [])
        .filter((node) => node.properties?.dataMarkdownGallery === true)
        .flatMap((gallery) => gallery.children ?? [])
        .map((figure) => {
          const label = String(figure.properties?.dataCaption ?? "");
          const authored = (figure.children ?? []).slice(1).map(plain).join("");
          return [label, authored].filter(Boolean).join(" · ");
        });
}

const MUSEUM = "https://upload.wikimedia.org/salem.jpg";
const COMMONS = "https://commons.wikimedia.org/wiki/File:Salem.jpg";

describe("groupInlineImageGalleries figure paragraphs", () => {
  it("makes a paragraph with only an image a captioned figure", () => {
    const tree = groupInlineImageGalleries(root(p(img(MUSEUM, "Salem Witch Museum"))));
    expect(captionText(tree)).toEqual(["Salem Witch Museum"]);
    expect(tree.children?.[0]?.properties?.dataGalleryCount).toBe(1);
  });

  it("captions an image followed by its source link with the alt text and the link", () => {
    const tree = groupInlineImageGalleries(
      root(p(img(MUSEUM, "Salem Witch Museum"), text(" "), a(COMMONS, text("Wikimedia Commons")))),
    );
    expect(galleries(tree)).toEqual([
      [
        {
          caption: "Salem Witch Museum",
          src: MUSEUM,
          source: COMMONS,
          sourceLabel: "Wikimedia Commons",
        },
      ],
    ]);
    expect(captionText(tree)).toEqual(["Salem Witch Museum · Wikimedia Commons"]);
  });

  it("drops the separator between an image and its link, and uses an authored caption over alt", () => {
    const dotted = groupInlineImageGalleries(
      root(p(img(MUSEUM, "Museum"), text(" · "), a(COMMONS, text("Wikimedia Commons")))),
    );
    expect(captionText(dotted)).toEqual(["Museum · Wikimedia Commons"]);

    const authored = groupInlineImageGalleries(
      root(
        p(
          img(MUSEUM, "Museum"),
          text(" "),
          em(text("The museum at dusk")),
          // oxlint-disable-next-line t3code/no-em-dash-in-copy -- authored markdown keeps the separator it was written with
          text(" — "),
          a(COMMONS, text("Wikimedia Commons")),
        ),
      ),
    );
    // Separators between authored parts stay as written.
    // oxlint-disable-next-line t3code/no-em-dash-in-copy -- authored markdown keeps the separator it was written with
    expect(captionText(authored)).toEqual(["The museum at dusk — Wikimedia Commons"]);
  });

  it("takes a bold title line above and a credit line below into the caption", () => {
    const tree = groupInlineImageGalleries(
      root(
        p(
          text("Some context first.\n"),
          { type: "element", tagName: "strong", children: [text("Freedom Trail")] },
          text("\n"),
          img("https://a.test/trail.jpg", "Trail"),
          text("\nSource: "),
          a(COMMONS, text("Wikimedia")),
        ),
      ),
    );
    expect(tree.children?.map((node) => node.tagName)).toEqual(["p", "div"]);
    expect(plain(tree.children?.[0] ?? text(""))).toBe("Some context first.");
    expect(captionText(tree)).toEqual(["Freedom Trail · Source: Wikimedia"]);
  });

  it("puts several captioned images of one paragraph in one gallery row", () => {
    const tree = groupInlineImageGalleries(
      root(
        p(
          img("https://a.test/1.jpg", "One"),
          text(" "),
          a(COMMONS, text("Commons")),
          text("\n"),
          img("https://a.test/2.jpg", "Two"),
          text(" · "),
          a("https://example.com/two", text("Example")),
        ),
      ),
    );
    expect(galleries(tree).map((row) => row.map((figure) => figure.source))).toEqual([
      [COMMONS, "https://example.com/two"],
    ]);
    expect(tree.children?.[0]?.properties?.dataGalleryCount).toBe(2);
  });

  it("keeps an image inside a sentence inline, with or without a link", () => {
    const before = p(text("The logo "), img("https://a.test/logo.png"), text(" sits on top."));
    const after = p(
      img("https://a.test/logo.png"),
      text(" is our logo, see "),
      a(COMMONS, text("here")),
    );
    const unlinked = p(img("https://a.test/logo.png"), text(" Our logo, used everywhere."));
    const tree = groupInlineImageGalleries(root(before, after, unlinked));
    expect(tree.children).toEqual([before, after, unlinked]);
  });

  it("keeps a figure for an image that cannot load, such as plain http", () => {
    // The block placeholder replaces the image at render time; the caption stays.
    const tree = groupInlineImageGalleries(
      root(
        p(img("http://a.test/old.jpg", "Freedom Trail"), text(" "), a(COMMONS, text("Commons"))),
      ),
    );
    expect(galleries(tree)).toEqual([
      [
        {
          caption: "Freedom Trail",
          src: "http://a.test/old.jpg",
          source: COMMONS,
          sourceLabel: "Commons",
        },
      ],
    ]);
  });

  it("splits a tight list item into its text and a figure", () => {
    const item = li(
      text("Salem, the witch trial town.\n"),
      img(MUSEUM, "Museum"),
      text(" "),
      a(COMMONS, text("Commons")),
    );
    groupInlineImageGalleries(root(item));
    expect(item.children?.map((node) => node.tagName ?? node.type)).toEqual(["text", "div"]);
    expect(captionText(item)).toEqual(["Museum · Commons"]);
  });
});

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
          // oxlint-disable-next-line t3code/no-em-dash-in-copy -- authored markdown keeps the separator it was written with
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
          // "Source:" is a credit word, not a name, so the alt text still labels the caption.
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

describe("imageProxyUrl", () => {
  it("encodes the image URL as the proxy's only query parameter", () => {
    expect(
      imageProxyUrl(
        "https://app.test/api/image-proxy",
        "https://upload.wikimedia.org/a b.jpg?width=640&x=1#top",
      ),
    ).toBe(
      "https://app.test/api/image-proxy?url=https%3A%2F%2Fupload.wikimedia.org%2Fa+b.jpg%3Fwidth%3D640%26x%3D1%23top",
    );
    expect(
      imageProxyUrl("http://127.0.0.1:3773/api/image-proxy?stale=1", "https://a.test/1.png"),
    ).toBe("http://127.0.0.1:3773/api/image-proxy?url=https%3A%2F%2Fa.test%2F1.png");
  });
});

describe("resolveInlineImageSource", () => {
  const proxyEndpoint = "https://app.test/api/image-proxy";

  it("loads third-party https images through the proxy and keeps the original URL", () => {
    expect(resolveInlineImageSource("https://cdn.test/a.png", { proxyEndpoint })).toEqual({
      kind: "remote",
      url: "https://cdn.test/a.png",
      src: "https://app.test/api/image-proxy?url=https%3A%2F%2Fcdn.test%2Fa.png",
      proxied: true,
    });
    expect(resolveInlineImageSource("//cdn.test/a.png", { proxyEndpoint })).toMatchObject({
      url: "https://cdn.test/a.png",
      src: "https://app.test/api/image-proxy?url=https%3A%2F%2Fcdn.test%2Fa.png",
    });
  });

  it("loads directly without a proxy or from the app's own origin", () => {
    expect(resolveInlineImageSource("https://cdn.test/a.png")).toMatchObject({
      src: "https://cdn.test/a.png",
    });
    expect(
      resolveInlineImageSource("https://app.test/a.png", {
        proxyEndpoint,
        firstPartyOrigins: ["https://app.test"],
      }),
    ).toMatchObject({ src: "https://app.test/a.png" });
  });

  it("never loads plain http and ignores non-web sources", () => {
    expect(resolveInlineImageSource("http://cdn.test/a.png", { proxyEndpoint })).toEqual({
      kind: "blocked",
      url: "http://cdn.test/a.png",
    });
    expect(resolveInlineImageSource("data:image/png;base64,AAAA", { proxyEndpoint })).toBeNull();
    expect(resolveInlineImageSource("./a.png", { proxyEndpoint })).toBeNull();
  });
});

describe("remote image signing", () => {
  const proxyEndpoint = "https://app.test/api/image-proxy";
  const remote = (
    src: string,
    options: Parameters<typeof resolveInlineImageSource>[1] = { proxyEndpoint },
  ) => {
    const source = resolveInlineImageSource(src, options);
    if (source?.kind !== "remote") throw new Error("expected a remote image");
    return source;
  };

  it("asks the server to sign a proxied image by its authored URL", () => {
    expect(remoteImageAssetResource(remote("//cdn.test/a.png"))).toEqual({
      _tag: "remote-image",
      url: "https://cdn.test/a.png",
    });
  });

  it("signs nothing that loads as authored, blocked, or unknown", () => {
    expect(remoteImageAssetResource(remote("https://cdn.test/a.png", {}))).toBeNull();
    expect(
      remoteImageAssetResource(
        remote("https://app.test/a.png", {
          proxyEndpoint,
          firstPartyOrigins: ["https://app.test"],
        }),
      ),
    ).toBeNull();
    expect(
      remoteImageAssetResource(
        resolveInlineImageSource("http://cdn.test/a.png", { proxyEndpoint }),
      ),
    ).toBeNull();
    expect(remoteImageAssetResource(null)).toBeNull();
  });

  it("loads the signed URL, waits while it is minted, and falls back to the proxy on failure", () => {
    const source = remote("https://cdn.test/a.png");
    const signed = "https://app.test/api/assets/token.sig/a.png";
    expect(
      resolveRemoteImageSrc(source, { _tag: "Success", url: signed, expiresAt: Date.now() }),
    ).toBe(signed);
    expect(resolveRemoteImageSrc(source, { _tag: "Loading" })).toBeNull();
    expect(resolveRemoteImageSrc(source, { _tag: "Failure" })).toBe(source.src);
  });

  it("loads an unproxied image as authored without waiting for a signature", () => {
    const direct = remote("https://cdn.test/a.png", {});
    expect(resolveRemoteImageSrc(direct, { _tag: "Loading" })).toBe("https://cdn.test/a.png");
    expect(resolveRemoteImageSrc(direct, null)).toBe("https://cdn.test/a.png");
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
