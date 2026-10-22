// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import ts from "typescript-legacy";

/**
 * Scan an emitted bundle chunk for ESM imports of packages that are not Node
 * built-ins.
 *
 * Inside a Node single-executable, `import` statements and `import()` can only
 * resolve built-in modules; any file-backed specifier throws at module
 * evaluation (static) or at first use (dynamic). External packages therefore
 * have to be reached through `createRequire`, which reads the real filesystem
 * in every runtime. The bundler cannot enforce this, so the check reads what it
 * produced.
 */
export function findEsmImportsOfExternalPackages(source: string): ReadonlyArray<string> {
  const specifiers = new Set<string>();
  const module = ts.createSourceFile(
    "bundle.mjs",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const visit = (node: ts.Node): void => {
    const dynamic =
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const specifierNode =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : dynamic
          ? node.arguments[0]
          : undefined;
    if (specifierNode && ts.isStringLiteralLike(specifierNode)) {
      const specifier = specifierNode.text;
      // Multi-runtime SDKs can retain optional Bun imports. Those are runtime
      // built-ins, not packages to stage beside the executable. Static imports
      // still fail here because Node would evaluate them unconditionally.
      const runtimeBuiltin =
        NodeModule.isBuiltin(specifier) || (dynamic && specifier.startsWith("bun:"));
      if (!runtimeBuiltin && !specifier.startsWith("./") && !specifier.startsWith("../")) {
        specifiers.add(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module);
  return [...specifiers].sort();
}

/** `pkg` for `pkg/sub/path`, `@scope/pkg` for `@scope/pkg/sub/path`. */
function packageRoot(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function isCreateRequireCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    (ts.isIdentifier(callee) && callee.text === "createRequire") ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === "createRequire")
  );
}

/**
 * Scan an emitted bundle for packages it loads at runtime through
 * `createRequire`: `const req = createRequire(import.meta.url); req("pkg")`,
 * or `createRequire(import.meta.url)("pkg")` inline. Those are the packages
 * the executable expects in the `node_modules/` beside it, so each one must be
 * a runtime external that the CLI archive stages.
 */
export function findCreateRequiredPackages(source: string): ReadonlyArray<string> {
  const module = ts.createSourceFile(
    "bundle.mjs",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const requireNames = new Set<string>();
  const collectNames = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isCreateRequireCall(node.initializer)
    ) {
      requireNames.add(node.name.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isCreateRequireCall(node.right)
    ) {
      requireNames.add(node.left.text);
    }
    ts.forEachChild(node, collectNames);
  };
  collectNames(module);

  const packages = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const viaRequire =
        (ts.isIdentifier(callee) && requireNames.has(callee.text)) || isCreateRequireCall(callee);
      const specifier = node.arguments[0];
      if (viaRequire && specifier && ts.isStringLiteralLike(specifier)) {
        const name = specifier.text;
        if (!NodeModule.isBuiltin(name) && !name.startsWith(".") && !name.startsWith("/")) {
          packages.add(packageRoot(name));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module);
  return [...packages].sort();
}
