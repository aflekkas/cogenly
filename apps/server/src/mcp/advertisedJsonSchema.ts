import { memoize } from "effect/Function";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as Predicate from "effect/Predicate";
import { Tool } from "effect/ai";

type Json = unknown;
type JsonObject = { [key: string]: Json };

const isBareAnyOf = (value: Json): value is { anyOf: Array<Json> } =>
  Predicate.isObject(value) && Array.isArray(value.anyOf) && Object.keys(value).length === 1;

// A `Schema.fromJsonString` fallback. Advertised beside object shapes, it invites stringified input.
const isJsonStringSchema = (value: Json) =>
  Predicate.isObject(value) &&
  value.type === "string" &&
  value.contentMediaType === "application/json";

const SAFE_INTEGER_BOUNDS: Record<string, number> = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: Number.MIN_SAFE_INTEGER,
};

const tagOf = (branch: JsonObject, key: string): Json => {
  const property = Predicate.isObject(branch.properties) ? branch.properties[key] : undefined;
  return Predicate.isObject(property) && Array.isArray(property.enum) && property.enum.length === 1
    ? property.enum[0]
    : undefined;
};

/** One object for a tagged union of objects: each property once, the tag listing every value. */
const mergeTaggedObjects = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  if (branches.length < 2) return undefined;
  const objects = branches.filter(
    (branch): branch is JsonObject & { properties: JsonObject } =>
      Predicate.isObject(branch) &&
      branch.type === "object" &&
      Predicate.isObject(branch.properties),
  );
  if (objects.length !== branches.length) return undefined;
  const tag = Object.keys(objects[0]!.properties).find((key) => {
    const values = objects.map((object) => tagOf(object, key));
    return values.every((value) => value !== undefined) && new Set(values).size === values.length;
  });
  if (tag === undefined) return undefined;
  const properties: JsonObject = {
    [tag]: { type: "string", enum: objects.map((object) => tagOf(object, tag)) },
  };
  for (const object of objects) {
    for (const [name, property] of Object.entries(object.properties)) {
      if (name === tag) continue;
      const seen = properties[name];
      if (seen === undefined) properties[name] = property;
      else if (JSON.stringify(seen) !== JSON.stringify(property)) {
        const options = Predicate.isObject(seen) && isBareAnyOf(seen) ? seen.anyOf : [seen];
        if (!options.some((option) => JSON.stringify(option) === JSON.stringify(property)))
          properties[name] = { anyOf: [...options, property] };
      }
    }
  }
  const [first = [], ...others] = objects.map((object) =>
    Array.isArray(object.required) ? object.required : [],
  );
  const requiredByAll = first.filter(
    (name) => name !== tag && others.every((required) => required.includes(name)),
  );
  return { type: "object", properties, required: [tag, ...requiredByAll] };
};

const compact = (schema: Json): Json => {
  if (Array.isArray(schema)) return schema.map((item) => compact(item));
  if (!Predicate.isObject(schema)) return schema;
  let result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === true) continue;
    if (SAFE_INTEGER_BOUNDS[key] === value) continue;
    result[key] =
      key === "properties" && Predicate.isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, property]) => [name, compact(property)]),
          )
        : compact(value);
  }
  if (Array.isArray(result.anyOf)) {
    const branches = result.anyOf
      .flatMap((branch) => (isBareAnyOf(branch) ? branch.anyOf : [branch]))
      .filter((branch) => !isJsonStringSchema(branch));
    const { anyOf: _anyOf, ...rest } = result;
    const only = branches.length === 1 ? branches[0] : mergeTaggedObjects(branches);
    result = Predicate.isObject(only) ? { ...only, ...rest } : { ...rest, anyOf: branches };
  }
  return result;
};

/** Remove optional undefined before the JSON codec turns it into null. Explicit null clears survive. */
const withoutOptionalUndefined: (ast: SchemaAST.AST) => SchemaAST.AST = memoize((ast) => {
  switch (ast._tag) {
    case "Objects":
      return new SchemaAST.Objects(
        ast.propertySignatures.map(
          (property) =>
            new SchemaAST.PropertySignature(property.name, withoutOptionalUndefined(property.type)),
        ),
        ast.indexSignatures.map(
          (index) =>
            new SchemaAST.IndexSignature(index.parameter, withoutOptionalUndefined(index.type)),
        ),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
        ast.encodingChecks,
      );
    case "Arrays":
      return new SchemaAST.Arrays(
        ast.isMutable,
        ast.elements.map(withoutOptionalUndefined),
        ast.rest.map(withoutOptionalUndefined),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
        ast.encodingChecks,
      );
    case "Union":
      return new SchemaAST.Union(
        ast.types
          .filter((type) => !SchemaAST.isOptional(ast) || type._tag !== "Undefined")
          .map(withoutOptionalUndefined),
        ast.options,
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
        ast.encodingChecks,
      );
    case "Suspend":
      return new SchemaAST.Suspend(
        () => withoutOptionalUndefined(ast.thunk()),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      );
    default:
      return ast;
  }
});

/**
 * Compact advertisement only. Full parameter schemas still validate calls, including each
 * tagged branch's required fields. Keep explicit null clears and meaningful numeric bounds.
 */
export const advertisedJsonSchema = (tool: Tool.Any) =>
  compact(
    Tool.getJsonSchemaFromSchema(
      Schema.make(withoutOptionalUndefined(SchemaAST.toEncoded(tool.parametersSchema.ast))),
    ),
  ) as ReturnType<typeof Tool.getJsonSchema>;
