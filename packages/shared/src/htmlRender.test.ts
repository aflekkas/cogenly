import { describe, expect, it } from "vite-plus/test";

// @effect-diagnostics nodeBuiltinImport:off - executes the shipped bootstrap validators.
import * as NodeVM from "node:vm";
import {
  encodeHtmlRenderOutline,
  formatVisualSubmitMessage,
  HTML_RENDER_APP_FONT_FAMILY,
  HTML_RENDER_APP_FONT_FILES,
  HTML_RENDER_MAX_HEIGHT,
  htmlRenderFontFaceCss,
  htmlRenderFrameHeight,
  htmlRenderOutlineBoxes,
  htmlRenderReferencesEqual,
  htmlRenderTheme,
  htmlRenderThemeFragment,
  injectHtmlRenderBootstrap,
  htmlRenderKitOptedOut,
  HTML_RENDER_KIT_GUIDE,
  HTML_RENDER_KIT_STYLE_ID,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderImageRequest,
  readHtmlRenderKeyDown,
  readHtmlRenderLinkRequest,
  readHtmlRenderReference,
  readVisualSubmitMessage,
  type HtmlRenderFontFace,
} from "./htmlRender.ts";
import { T3_CODE_DARK_THEME_COLORS, T3_CODE_LIGHT_THEME_COLORS } from "./themePalettes.ts";
import { htmlRenderFromToolItem } from "./toolOutput.ts";

const reference = { attachmentId: "thread-abc-123.html", title: "Chart", height: 420 };

describe("injectHtmlRenderBootstrap", () => {
  it("puts the theme ahead of the page's own head content", () => {
    const html =
      "<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const themeAt = injected.indexOf('<style id="t3-theme">');
    expect(themeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(themeAt).toBeLessThan(injected.indexOf(":root{--background:red}"));
    expect(injected).toContain('<meta charset="utf-8">');
    expect(injected).toContain('name="viewport"');
  });

  it("wraps fragments without a head and keeps existing meta tags", () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>';
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/name="viewport"/g)).toHaveLength(1);
    expect(injected.endsWith("<p>hi</p>")).toBe(true);
  });

  it.each(["textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"])(
    "keeps the bootstrap outside %s content",
    (tag) => {
      const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`;
      const injected = injectHtmlRenderBootstrap(fragment);
      expect(injected.startsWith("<!doctype html><head>")).toBe(true);
      expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf(`<${tag}>`));
      expect(injected).toContain('<meta name="viewport" content="width=device-width');
      expect(injected.endsWith(fragment)).toBe(true);
    },
  );

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>',
  ])("keeps the bootstrap outside inert template content: %s", (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf("<template>"));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it("injects the Cogenly kit after the bridge and before the page's own styles", () => {
    const html =
      "<!doctype html><html><head><style>.cg-card{padding:0}</style></head><body><div class=cg-card>x</div></body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const kitAt = injected.indexOf(`<style id="${HTML_RENDER_KIT_STYLE_ID}">`);
    expect(kitAt).toBeGreaterThan(injected.indexOf("window.cogenly="));
    expect(kitAt).toBeLessThan(injected.indexOf("<style>.cg-card{padding:0}"));
    expect(injected).toContain('customElements.define("cg-tabs"');
    expect(injected).toContain('customElements.define("cg-choice"');
    // The kit styles against the injected theme, never its own colors.
    const kitCss = injected.slice(kitAt, injected.indexOf("</style>", kitAt));
    expect(kitCss).not.toMatch(/#[0-9a-f]{3,8}\b(?![^"]*")/i);
    expect(kitCss).toContain("--cg-chart-6:var(--chart-6)");
  });

  it("leaves only the theme when the page or the caller declines the kit", () => {
    const page = '<!doctype html><html lang="en" data-cg="off"><head></head><body>x</body></html>';
    for (const injected of [
      injectHtmlRenderBootstrap(page),
      injectHtmlRenderBootstrap("<!doctype html><html><body>x</body></html>", { kit: false }),
    ]) {
      expect(injected).toContain('<style id="t3-theme">');
      expect(injected).toContain("window.cogenly=");
      expect(injected).not.toContain(HTML_RENDER_KIT_STYLE_ID);
      expect(injected).not.toContain("cg-tabs");
    }
    expect(htmlRenderKitOptedOut(page)).toBe(true);
    expect(htmlRenderKitOptedOut("<html data-cg=off>")).toBe(true);
    expect(htmlRenderKitOptedOut('<html data-cg="on">')).toBe(false);
    expect(htmlRenderKitOptedOut('<!-- <html data-cg="off"> --><html>')).toBe(false);
    expect(htmlRenderKitOptedOut("<p>no html tag</p>")).toBe(false);
  });

  it("ignores tags written inside comments and scripts", () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      "<script>const tag = '<meta name=\"viewport\">';</script></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.indexOf('<style id="t3-theme">')).toBeGreaterThan(
      injected.indexOf("<html><head>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
  });
});

describe("readHtmlRenderLinkRequest", () => {
  it("accepts only http(s) URLs in an MCP Apps ui/open-link request", () => {
    const link = (url: unknown, modifiers = {}) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url, ...modifiers },
    });
    expect(readHtmlRenderLinkRequest(link("https://example.com/a"))).toEqual({
      id: 1,
      url: "https://example.com/a",
      metaKey: false,
      ctrlKey: false,
    });
    expect(
      readHtmlRenderLinkRequest(link("https://example.com/a", { metaKey: true, ctrlKey: "yes" })),
    ).toEqual({ id: 1, url: "https://example.com/a", metaKey: true, ctrlKey: false });
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("file:///etc/passwd"))).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({ type: "t3-html-render-link", url: "https://example.com" }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderImageRequest", () => {
  it("accepts http(s) and inline image URLs in an open-image notification", () => {
    const image = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "t3/notifications/open-image",
      params,
    });
    expect(
      readHtmlRenderImageRequest(image({ src: "data:image/png;base64,AA", name: " Chart " })),
    ).toEqual({
      src: "data:image/png;base64,AA",
      name: "Chart",
    });
    expect(readHtmlRenderImageRequest(image({ src: "https://example.com/a.png" }))).toEqual({
      src: "https://example.com/a.png",
      name: "Image",
    });
    expect(readHtmlRenderImageRequest(image({ src: "javascript:alert(1)" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "data:text/html,<p>" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "blob:null/1" }))).toBeUndefined();
  });
});

describe("readHtmlRenderKeyDown", () => {
  it("reads the key of a keydown notification and nothing else", () => {
    const notification = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "t3/notifications/keydown",
      params,
    });
    expect(readHtmlRenderKeyDown(notification({ key: "k", code: "KeyK", metaKey: true }))).toEqual({
      key: "k",
      code: "KeyK",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
    });
    expect(readHtmlRenderKeyDown(notification({ key: 1, code: "KeyK" }))).toBeUndefined();
    expect(
      readHtmlRenderKeyDown({ jsonrpc: "2.0", method: "ui/open-link", params: { key: "k" } }),
    ).toBeUndefined();
  });
});

describe("readVisualSubmitMessage", () => {
  it("reads back what formatVisualSubmitMessage writes", () => {
    const payload = { kind: "quiz-result", score: 2, answers: ["a", 'say "hi"'] };
    expect(
      readVisualSubmitMessage(
        formatVisualSubmitMessage('Capitals "quiz"', JSON.stringify(payload, null, 2)),
      ),
    ).toEqual({
      title: 'Capitals "quiz"',
      json: JSON.stringify(payload, null, 2),
      payload,
    });
    expect(readVisualSubmitMessage(formatVisualSubmitMessage("  ", "null"))).toEqual({
      title: null,
      json: "null",
      payload: null,
    });
  });

  it("keeps a fence that is not valid JSON as text", () => {
    expect(readVisualSubmitMessage('[Visual "Plan" submitted]\n```json\n{oops\n```')).toEqual({
      title: "Plan",
      json: "{oops",
      payload: undefined,
    });
  });

  it("ignores ordinary messages that only mention a submit", () => {
    expect(readVisualSubmitMessage('[Visual "Plan" submitted]')).toBeUndefined();
    expect(
      readVisualSubmitMessage('I wrote [Visual "Plan" submitted]\n```json\n{}\n```'),
    ).toBeUndefined();
    expect(
      readVisualSubmitMessage('[Visual "Plan" submitted]\n```json\n{}\n```\nAnd one more thing'),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderContentHeight", () => {
  it("reads only the height of an MCP Apps size-changed notification", () => {
    const notification = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params,
    });
    expect(readHtmlRenderContentHeight(notification({ height: 412 }))).toBe(412);
    expect(readHtmlRenderContentHeight(notification({ height: "412" }))).toBe(undefined);
    expect(readHtmlRenderContentHeight(notification({ height: 0 }))).toBe(undefined);
    expect(readHtmlRenderContentHeight({ ...notification({ height: 412 }), method: "x" })).toBe(
      undefined,
    );
  });
});

describe("htmlRenderThemeMessage", () => {
  it("is an MCP Apps host-context-changed notification carrying the theme variables", () => {
    const theme = htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark");
    expect(htmlRenderThemeMessage(theme)).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark", styles: { variables: theme.variables } },
    });
  });
});

describe("htmlRenderTheme", () => {
  it("exposes the brand accent as --accent and keeps the fragment decodable", () => {
    const theme = htmlRenderTheme(T3_CODE_LIGHT_THEME_COLORS, "light");
    expect(theme.variables["--accent"]).toBe(T3_CODE_LIGHT_THEME_COLORS.accent);
    expect(theme.variables["--chart-1"]).toBe(T3_CODE_LIGHT_THEME_COLORS.accent);
    expect(theme.variables["--chart-6"]).toBeDefined();
    const fragment = htmlRenderThemeFragment(theme);
    expect(JSON.parse(decodeURIComponent(fragment.slice("#t3-theme=".length)))).toEqual(theme);
    expect(fragment).not.toContain("&");
    expect(htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark").variables["--background"]).toBe(
      T3_CODE_DARK_THEME_COLORS.canvas,
    );
  });

  it("sets the app family first once its faces arrive, and never twice", () => {
    const faces: ReadonlyArray<HtmlRenderFontFace> = [
      { url: "https://app.example/assets/inter-latin.woff2", unicodeRange: "U+0000-00FF" },
    ];
    const themed = htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", undefined, faces);
    expect(themed.fontFaces).toEqual(faces);
    expect(themed.variables["--font-sans"]).toMatch(
      new RegExp(`^"${HTML_RENDER_APP_FONT_FAMILY}", `),
    );
    const fragment = htmlRenderThemeFragment(themed);
    expect(JSON.parse(decodeURIComponent(fragment.slice("#t3-theme=".length)))).toEqual(themed);
    expect(htmlRenderThemeMessage(themed).params).toMatchObject({ fontFaces: faces });
    // A stack already starting with the app family is left alone.
    const already = htmlRenderTheme(
      T3_CODE_DARK_THEME_COLORS,
      "dark",
      { sans: `"${HTML_RENDER_APP_FONT_FAMILY}", sans-serif`, mono: "monospace" },
      faces,
    );
    expect(already.variables["--font-sans"]).toBe(`"${HTML_RENDER_APP_FONT_FAMILY}", sans-serif`);
    // Without faces the stack stays as passed and the message stays lean.
    const plain = htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark");
    expect(plain.fontFaces).toBeUndefined();
    expect(plain.variables["--font-sans"]).not.toContain(HTML_RENDER_APP_FONT_FAMILY);
    expect("fontFaces" in htmlRenderThemeMessage(plain).params).toBe(false);
  });
});

describe("htmlRenderFontFaceCss", () => {
  const faces: ReadonlyArray<HtmlRenderFontFace> = HTML_RENDER_APP_FONT_FILES.map((file) => ({
    url: `https://app.example/assets/${file.file}`,
    unicodeRange: file.unicodeRange,
  }));

  it("declares one subset face per entry, latin first", () => {
    const css = htmlRenderFontFaceCss(faces);
    expect(css).toContain(`font-family:"${HTML_RENDER_APP_FONT_FAMILY}"`);
    expect(css).toContain("font-weight:100 900");
    expect(css).toContain('src:url("https://app.example/assets/inter-latin-wght-normal.woff2")');
    expect(css).toContain("unicode-range:U+0000-00FF");
    expect(css.indexOf("inter-latin-wght-normal")).toBeLessThan(
      css.indexOf("inter-latin-ext-wght-normal"),
    );
  });

  it("drops faces that could break out of the stylesheet", () => {
    expect(htmlRenderFontFaceCss([])).toBe("");
    for (const face of [
      { url: "javascript:alert(1)", unicodeRange: "U+0000-00FF" },
      { url: "/relative/path.woff2", unicodeRange: "U+0000-00FF" },
      { url: 'https://app.example/a".woff2', unicodeRange: "U+0000-00FF" },
      { url: "https://app.example/a.woff2", unicodeRange: "U+0000-00FF;}</style><script>alert(1)" },
      { url: "https://app.example/a.woff2", unicodeRange: "latin" },
    ]) {
      expect(htmlRenderFontFaceCss([face])).toBe("");
    }
  });

  it("ships the face handler in the bootstrap but no faces without a host", () => {
    const injected = injectHtmlRenderBootstrap("<!doctype html><html><body>x</body></html>");
    // The updater that themes arriving over postMessage run through.
    expect(injected).toContain(`font-family:"${HTML_RENDER_APP_FONT_FAMILY}"`);
    expect(injected).toContain("fontFaces");
    // Stored pages carry no faces: a download has no parent origin to load them from.
    const style = /<style id="t3-theme">(.*?)<\/style>/s.exec(injected)?.[1] ?? "";
    expect(style).not.toContain("@font-face");
  });

  it("ships validators that parse and agree with htmlRenderFontFaceCss", () => {
    const injected = injectHtmlRenderBootstrap("<!doctype html><html><body>x</body></html>");
    const script = /<script>([\s\S]*?)<\/script>/.exec(injected)?.[1] ?? "";
    // A syntax slip in the embedded script breaks every render's theme,
    // bridge and kit at once: it must at least parse.
    expect(() => new NodeVM.Script(script)).not.toThrow();
    const start = script.indexOf("function v(u)");
    const end = script.indexOf("function a(t)");
    const validators = new NodeVM.Script(
      `${script.slice(start, end)}; ({ v, r, o });`,
    ).runInNewContext({}) as unknown as {
      readonly v: (url: unknown) => boolean;
      readonly r: (range: unknown) => boolean;
      readonly o: (faces: ReadonlyArray<HtmlRenderFontFace>) => string | null;
    };
    expect(validators.v("https://app.example/assets/inter-latin.woff2")).toBe(true);
    expect(validators.v("http://localhost:9733/assets/inter-latin.woff2")).toBe(true);
    expect(validators.v("javascript:alert(1)")).toBe(false);
    expect(validators.v("/relative/inter.woff2")).toBe(false);
    expect(validators.v('https://app.example/a".woff2')).toBe(false);
    expect(validators.r("U+0000-00FF")).toBe(true);
    expect(validators.r("U+0100-02BA,U+02BD-02C5")).toBe(true);
    expect(validators.r("latin")).toBe(false);
    expect(validators.r("U+0000-00FF;}</style>")).toBe(false);
    // The embedded copy emits what the server-side helper emits, and rejects
    // a bad entry wholesale rather than a bad page's faces.
    const faces: ReadonlyArray<HtmlRenderFontFace> = HTML_RENDER_APP_FONT_FILES.map((file) => ({
      url: `https://app.example/assets/${file.file}`,
      unicodeRange: file.unicodeRange,
    }));
    expect(validators.o(faces)).toBe(htmlRenderFontFaceCss(faces));
    expect(validators.o([{ url: "javascript:alert(1)", unicodeRange: "U+0000-00FF" }])).toBe(null);
  });
});

describe("HTML_RENDER_KIT_GUIDE", () => {
  it("names the opt-out, the classes, the components and shows an example", () => {
    expect(HTML_RENDER_KIT_GUIDE).toContain('data-cg="off"');
    expect(HTML_RENDER_KIT_GUIDE).toContain("kit:false");
    for (const name of [
      ".cg-card",
      ".cg-grid",
      ".cg-stack",
      ".cg-button",
      ".cg-badge",
      ".cg-table",
      ".cg-stat",
      ".cg-list",
      ".cg-row",
      ".cg-input",
      ".cg-select",
      ".cg-checkbox",
      ".cg-radio",
      ".cg-divider",
      ".cg-link",
      ".cg-image",
      "--cg-chart-1",
      "<cg-tabs",
      "<cg-choice",
      "data-cg-submit",
    ]) {
      expect(HTML_RENDER_KIT_GUIDE).toContain(name);
    }
    expect(HTML_RENDER_KIT_GUIDE).toContain('<div class="cg-card');
    // It rides along on every html_render call, so it stays short.
    expect(HTML_RENDER_KIT_GUIDE.length).toBeLessThan(3200);
  });
});

describe("readHtmlRenderReference", () => {
  it("clamps height and rejects malformed references", () => {
    expect(readHtmlRenderReference({ ...reference, height: 99_999 })?.height).toBe(2000);
    expect(readHtmlRenderReference({ ...reference, title: "  " })?.title).toBe("HTML");
    expect(readHtmlRenderReference({ ...reference, attachmentId: 4 })).toBeUndefined();
    expect(readHtmlRenderReference({ ...reference, height: Number.NaN })).toBeUndefined();
  });
});

describe("htmlRenderFromToolItem", () => {
  const result = { htmlRender: reference, message: "Rendered above your reply." };

  it("reads the reference from each provider's result envelope", () => {
    for (const [toolName, output] of [
      ["mcp__t3-code__html_render", [{ type: "text", text: JSON.stringify(result) }]],
      ["t3-code.html_render", { structuredContent: result, content: [] }],
      ["t3-code-thread_1_html_render", JSON.stringify(result)],
      ["html_render", result],
    ] as const) {
      expect(htmlRenderFromToolItem({ toolName, output })).toEqual(reference);
    }
  });

  it("ignores other tools and failed calls", () => {
    expect(htmlRenderFromToolItem({ toolName: "mcp__t3-code__html_preview", output: result })).toBe(
      undefined,
    );
    expect(htmlRenderFromToolItem({ toolName: "mcp__other__html_render", output: result })).toBe(
      undefined,
    );
    expect(
      htmlRenderFromToolItem({ toolName: "html_render", output: { ...result, isError: true } }),
    ).toBeUndefined();
  });
});

describe("htmlRenderFrameHeight", () => {
  const measured = readHtmlRenderReference({
    ...reference,
    height: 1500,
    heights: [
      [728, 1403],
      [390, 1290],
      [1000, 1660],
    ],
  })!;

  it("takes the taller neighbor between measured widths and holds the ends", () => {
    expect(measured.heights?.map(([width]) => width)).toEqual([390, 728, 1000]);
    expect(htmlRenderFrameHeight(measured, 728)).toBe(1403);
    expect(htmlRenderFrameHeight(measured, 559)).toBe(1403);
    expect(htmlRenderFrameHeight(measured, 320)).toBe(1290);
  });

  it("takes the taller layout when a breakpoint falls between measured widths", () => {
    // 900px tall below a 600px media query, 450px above it.
    const responsive = readHtmlRenderReference({
      ...reference,
      height: 2000,
      heights: [
        [520, 900],
        [640, 450],
      ],
    })!;
    expect(htmlRenderFrameHeight(responsive, 590)).toBe(900);
    expect(htmlRenderFrameHeight(responsive, 640)).toBe(450);
  });

  it("fits a page the client lays out taller than the server measured", () => {
    // The agent passed contentHeight at the column width, so the page should never scroll.
    const fitted = { ...measured, height: 1403 };
    expect(htmlRenderFrameHeight(fitted, 728, 1415)).toBe(1415);
    expect(htmlRenderFrameHeight(fitted, 1400)).toBe(1660);
    expect(htmlRenderFrameHeight(fitted, 728, 5000)).toBe(HTML_RENDER_MAX_HEIGHT);
  });

  it("keeps the agent's height when it asked for a scrolling frame or the page is unmeasured", () => {
    const scrolling = { ...measured, height: 600 };
    expect(htmlRenderFrameHeight(scrolling, 728, 1415)).toBe(600);
    expect(htmlRenderFrameHeight(scrolling, 1400)).toBe(600);
    expect(htmlRenderFrameHeight(reference, 728)).toBe(reference.height);
    expect(htmlRenderFrameHeight(reference, 728, 900)).toBe(reference.height);
    expect(htmlRenderFrameHeight(reference, 728, 300)).toBe(300);
  });

  it("drops a malformed table and compares tables by value", () => {
    expect(readHtmlRenderReference({ ...reference, heights: [[728, "x"]] })?.heights).toBe(
      undefined,
    );
    const copy = readHtmlRenderReference(JSON.parse(JSON.stringify(measured)))!;
    expect(htmlRenderReferencesEqual(measured, copy)).toBe(true);
    expect(htmlRenderReferencesEqual(measured, { ...copy, heights: [[390, 1290]] })).toBe(false);
  });
});

describe("htmlRenderOutlineBoxes", () => {
  const outline = encodeHtmlRenderOutline([
    { kind: "text", x: 0, y: 0, width: 300, height: 40, lines: 2 },
    { kind: "media", x: 0, y: 48, width: 728, height: 300, lines: 1 },
    { kind: "media", x: 2, y: 2, width: 0, height: 10, lines: 1 },
  ]);
  const outlined = readHtmlRenderReference({
    ...reference,
    heights: [
      [364, 1600],
      [728, 800],
    ],
    outline,
  })!;

  it("round-trips through a tool result and stretches to the client's width and height", () => {
    // The empty box is dropped when encoded.
    expect(outline).toBe("t0,0,75,10,2;m0,12,182,75,1");
    expect(htmlRenderOutlineBoxes(outlined, 728)).toEqual([
      { kind: "text", x: 0, y: 0, width: 300, height: 40, lines: 2 },
      { kind: "media", x: 0, y: 48, width: 728, height: 300, lines: 1 },
    ]);
    expect(htmlRenderOutlineBoxes(outlined, 364)[1]).toEqual({
      kind: "media",
      x: 0,
      y: 96,
      width: 364,
      height: 600,
      lines: 1,
    });
  });

  it("drops a malformed or unmeasured outline", () => {
    expect(readHtmlRenderReference({ ...outlined, outline: "x1,2" })?.outline).toBeUndefined();
    expect(
      readHtmlRenderReference({ ...outlined, outline: "t0,0,10,10,0" })?.outline,
    ).toBeUndefined();
    expect(
      readHtmlRenderReference({ ...outlined, outline: "m0,0,0,10,1" })?.outline,
    ).toBeUndefined();
    expect(readHtmlRenderReference({ ...reference, outline })?.outline).toBeUndefined();
    expect(htmlRenderOutlineBoxes(reference, 728)).toEqual([]);
    expect(htmlRenderReferencesEqual(outlined, { ...outlined, outline: "m0,0,1,1,1" })).toBe(false);
  });
});
