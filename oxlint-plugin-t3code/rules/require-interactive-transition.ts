import { defineRule, type ESTree } from "@oxlint/plugins";

const CLASS_COMPOSERS = new Set(["cn", "clsx", "classNames", "cva", "twMerge"]);
// Anything that declares how the element animates, including an explicit opt-out.
const TRANSITION =
  /^(?:interactive|transition(?:-.+)?|state-hover|state-selected|sidebar-row-motion)$/u;

/** Splits `dark:hover:bg-muted/40` into its variants and utility, ignoring colons inside brackets. */
function parseClass(token: string) {
  const variants: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    const character = token[index];
    if (character === "[" || character === "(") depth++;
    else if (character === "]" || character === ")") depth--;
    else if (character === ":" && depth === 0) {
      variants.push(token.slice(start, index));
      start = index + 1;
    }
  }
  return { variants, utility: token.slice(start).replace(/^!|!$/gu, "") };
}

const isClassComposer = (node: ESTree.Node) =>
  node.type === "CallExpression" &&
  node.callee.type === "Identifier" &&
  CLASS_COMPOSERS.has(node.callee.name);

/** Every string in a composition, branches included: a transition in any of them counts. */
function collectStrings(node: unknown, out: string[]) {
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out);
    return;
  }
  if (typeof node !== "object" || node === null || !("type" in node)) return;
  const current = node as ESTree.Node;
  if (current.type === "CallExpression" && !isClassComposer(current)) return;
  if (current.type === "Literal" && typeof current.value === "string") out.push(current.value);
  if (current.type === "TemplateElement") out.push(current.value.cooked ?? current.value.raw);
  for (const [key, value] of Object.entries(current)) {
    if (key !== "parent") collectStrings(value, out);
  }
}

/** The JSX element a class string styles, if any. */
function styledElement(node: ESTree.Node) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "JSXOpeningElement") return current;
    if (/Statement$|Declaration$/u.test(current.type)) return undefined;
  }
  return undefined;
}

function hasTransitionInScope(node: ESTree.Node, own: string) {
  const strings = [own];
  for (let current = node.parent; current; current = current.parent) {
    if (/Statement$|Declaration$|^JSX(?:Attribute|Element)$/u.test(current.type)) break;
    if (isClassComposer(current)) collectStrings(current, strings);
  }
  return strings
    .join(" ")
    .split(/\s+/u)
    .some((token) => TRANSITION.test(parseClass(token).utility));
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Hand-rolled hover fills on raw elements must transition, so hover fades like the primitives instead of snapping.",
    },
  },
  create(context) {
    const check = (node: ESTree.Node, text: string) => {
      const hoverFill = text.split(/\s+/u).find((token) => {
        const { variants, utility } = parseClass(token);
        return variants.includes("hover") && utility.startsWith("bg-");
      });
      if (!hoverFill) return;
      // A component (Button, a feature row) owns its transition; only raw elements are checked.
      const element = styledElement(node);
      if (element?.name.type === "JSXIdentifier" && /^[A-Z]/u.test(element.name.name)) return;
      if (element && element.name.type !== "JSXIdentifier") return;
      if (hasTransitionInScope(node, text)) return;
      context.report({
        node,
        message: `${hoverFill} snaps. Add \`interactive\` (index.css) so the fill fades on the shared timing, or use state-hover or a components/ui primitive.`,
      });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateLiteral(node) {
        check(node, node.quasis.map((part) => part.value.cooked ?? part.value.raw).join(" "));
      },
    };
  },
});
