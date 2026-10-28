import { parseChangeRequestUrl } from "@cogenly/shared/changeRequestUrl";

interface Word {
  text: string;
  quoted: boolean;
}
/** A conservative shell word reader, used only to recognize CLI creation commands. */
function segments(script: string): Word[][] | undefined {
  const result: Word[][] = [[]];
  let word = "",
    quoted = false,
    quote: string | undefined;
  const flush = () => {
    if (word || quoted) result.at(-1)!.push({ text: word, quoted });
    word = "";
    quoted = false;
  };
  for (let i = 0; i < script.length; i++) {
    const char = script[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"') word += script[++i] ?? "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
    } else if (char === "\\") word += script[++i] ?? "";
    else if (char === "#" && !word) {
      while (i < script.length && script[i] !== "\n") i++;
      flush();
      result.push([]);
    } else if (/[;&|\n]/.test(char)) {
      flush();
      result.push([]);
    } else if (/\s/.test(char)) flush();
    else word += char;
  }
  if (quote) return;
  flush();
  return result.filter((words) => words.length > 0);
}

/** Only an executed `gh pr create` with one standalone PR URL proves a newly created PR. */
export function shellCreatedPullRequest(input: string, output: string) {
  if (!/\bgh\s+pr\s+create\b/.test(input)) return;
  let script = input;
  let commands = segments(script);
  if (!commands) return;
  const wrapper = commands.length === 1 ? commands[0] : undefined;
  if (
    wrapper &&
    /(?:^|\/)(?:ba|z|da|k)?sh$/.test(wrapper[0]?.text ?? "") &&
    /^-l?c$/.test(wrapper[1]?.text ?? "") &&
    wrapper.length === 3
  ) {
    script = wrapper[2]!.text;
  }
  // Substitution and nested control flow need a shell parser; explicit linking is the fallback.
  if (/`|\$\(|[{}]/.test(script)) return;
  script = script.replace(/<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[\t ]*\2(?=\n|$)/g, "<<");
  if (script.includes("<<") && !/<<\s*(?:\n|$)/.test(script)) return;
  commands = segments(script);
  if (!commands) return;
  const creators: Word[][] = [],
    others: Word[][] = [];
  for (const words of commands) {
    let index = 0;
    while (
      words[index] &&
      (/^[A-Za-z_]\w*=/.test(words[index]!.text) ||
        ["env", "time", "nohup"].includes(words[index]!.text))
    )
      index++;
    if (words[index]?.text === "timeout" && words[index + 1]) index += 2;
    const start = words.slice(index, index + 3);
    if (
      start.length === 3 &&
      start.every((word) => !word.quoted) &&
      /(?:^|\/)gh$/.test(start[0]!.text) &&
      start[1]!.text === "pr" &&
      start[2]!.text === "create"
    )
      creators.push(words);
    else others.push(words);
  }
  if (creators.length !== 1) return;
  // Listing, API calls, or viewing an existing PR makes the output's provenance unclear.
  if (
    others.some((words) =>
      /\bgh\s+(?:pr\s+(?:list|status|view)|search\s+prs|api)\b/.test(
        words.map((word) => word.text).join(" "),
      ),
    )
  )
    return;
  const urls = new Set(
    Array.from(output.matchAll(/^[\t ]*(https?:\/\/\S+)[\t ]*$/gm), (match) => match[1]!),
  );
  if (urls.size !== 1) return;
  const url = [...urls][0]!;
  const parsed = parseChangeRequestUrl(url);
  if (!parsed || !/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(new URL(url).pathname)) return;
  const named = new RegExp(`(?:^|[\\s#/=("'])${parsed.number}(?:$|[\\s);&|/"'])`);
  if (
    others.some((words) => words.some((word) => word.text.includes(url) || named.test(word.text)))
  )
    return;
  return { ...parsed, url };
}
