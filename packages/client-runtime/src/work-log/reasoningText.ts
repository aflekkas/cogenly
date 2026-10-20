const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Removes bold and heading markup from one line, leaving code spans untouched. */
function quietLine(line: string): string {
  const heading = line.replace(/^\s{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/, "$1");
  return heading
    .split(/(`+[^`]*`+)/)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2"),
    )
    .join("");
}

/**
 * Reasoning summaries arrive as markdown whose sections are `**Heading**`
 * lines (Codex) or `#` headings. The work log shows them as quiet secondary
 * text, so this drops bold and heading markup while keeping inline code,
 * links, lists and fenced code as written.
 */
export function quietReasoningMarkdown(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence !== null) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      // Setext underlines turn the previous line into a heading.
      if (/^\s{0,3}(?:=+|-{2,})\s*$/.test(line)) return "";
      return quietLine(line);
    })
    .join("\n");
}

/** Plain one-line text of a reasoning summary, for labels and accessible names. */
export function reasoningPlainText(markdown: string): string {
  return quietReasoningMarkdown(markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * One line of plain text from markdown or HTML-bearing agent output, for
 * previews (subagent results, the minimap). Drops headings, emphasis, list
 * markers, quotes, tables, code ticks and fences, HTML tags and link targets,
 * keeping the words and emoji.
 */
export function markdownPreviewText(markdown: string): string {
  return markdown
    .replace(/^\s{0,3}(`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/<\/?[A-Za-z][^<>]*>/g, " ")
    .replace(/&(#\d+|[a-z]+);/gi, (entity, name: string) =>
      name.startsWith("#")
        ? String.fromCodePoint(Number(name.slice(1)))
        : (HTML_ENTITIES[name.toLowerCase()] ?? entity),
    )
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/^\s{0,3}\[[^\]]+\]:\s+\S+.*$/gm, "")
    .replace(/^\s{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm, "$1")
    .replace(/^\s{0,3}(?:=+|-{2,}|(?:[*_][ \t]*){3,})\s*$/gm, "")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*(?::?-{3,}:?)?\s*$/gm, "")
    .replace(/^\s*\|(.*)\|\s*$/gm, (_line, cells: string) => cells.split("|").join(" "))
    .replace(/^\s{0,3}(?:>\s?)+/gm, "")
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/g, "$2")
    .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])/g, "$1")
    .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, "$1")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
