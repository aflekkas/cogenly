import { defineRule } from "@oxlint/plugins";

// The character itself plus the HTML entities that render as one in JSX text.
const EM_DASH_PATTERN = /\u2014|&mdash;|&#8212;|&#x2014;/iu;

const MESSAGE =
  "Copy never uses an em dash. Rewrite the sentence with a comma, colon, period or parentheses. A test that needs one disables this rule on that line with a reason.";

/**
 * Reports an em dash in a string literal, template literal or JSX text. Comments are not copy and
 * stay unchecked; `scripts/check-copy-dashes.ts` covers the user-facing markdown.
 */
export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow em dashes in strings and JSX text.",
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        if (EM_DASH_PATTERN.test(node.value)) context.report({ node, message: MESSAGE });
      },
      TemplateElement(node) {
        if (EM_DASH_PATTERN.test(node.value.cooked ?? node.value.raw)) {
          context.report({ node, message: MESSAGE });
        }
      },
      JSXText(node) {
        if (EM_DASH_PATTERN.test(node.raw ?? node.value)) {
          context.report({ node, message: MESSAGE });
        }
      },
    };
  },
});
