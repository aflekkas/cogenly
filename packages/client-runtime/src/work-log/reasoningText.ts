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
