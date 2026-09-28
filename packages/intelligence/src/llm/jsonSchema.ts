import { z } from "zod";

/**
 * Minimal zod -> JSON Schema (draft 2020-12 subset) converter used to build the
 * `input_schema` of the single structured-output tool sent to the Messages API.
 *
 * Supported: object, string, number, boolean, enum, array, nullable, optional, literal,
 * union of literals, record, tuple, default (unwrapped), branded/readonly (unwrapped).
 * Anything else throws `UnsupportedZodTypeError` so a schema never silently degrades
 * into an "anything goes" tool definition.
 */
export type JsonSchema = Record<string, unknown>;

export class UnsupportedZodTypeError extends Error {
  override readonly name = "UnsupportedZodTypeError";
  constructor(typeName: string, path: string) {
    super(`Unsupported zod type "${typeName}" at ${path || "<root>"}`);
  }
}

export interface ZodToJsonSchemaResult {
  schema: JsonSchema;
  /** True when every object property is required (safe for `strict: true`). */
  strictCompatible: boolean;
}

interface Ctx {
  strictCompatible: boolean;
}

function withDescription(schema: JsonSchema, def: z.ZodTypeAny): JsonSchema {
  const description = (def as { description?: string }).description;
  return description ? { ...schema, description } : schema;
}

function convert(schema: z.ZodTypeAny, path: string, ctx: Ctx): JsonSchema {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind } & Record<string, unknown>;
  const typeName = def.typeName;
  switch (typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convert(value, path ? `${path}.${key}` : key, ctx);
        if (value._def.typeName === z.ZodFirstPartyTypeKind.ZodOptional) {
          ctx.strictCompatible = false;
        } else {
          required.push(key);
        }
      }
      return withDescription({ type: "object", properties, required, additionalProperties: false }, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodString: {
      const out: JsonSchema = { type: "string" };
      for (const check of (def.checks as Array<{ kind: string; value?: number }> | undefined) ?? []) {
        if (check.kind === "min" && typeof check.value === "number") out.minLength = check.value;
        if (check.kind === "max" && typeof check.value === "number") out.maxLength = check.value;
      }
      return withDescription(out, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const out: JsonSchema = { type: "number" };
      for (const check of (def.checks as Array<{ kind: string; value?: number; inclusive?: boolean }> | undefined) ?? []) {
        if (check.kind === "int") out.type = "integer";
        if (check.kind === "min" && typeof check.value === "number") {
          out[check.inclusive === false ? "exclusiveMinimum" : "minimum"] = check.value;
        }
        if (check.kind === "max" && typeof check.value === "number") {
          out[check.inclusive === false ? "exclusiveMaximum" : "maximum"] = check.value;
        }
      }
      return withDescription(out, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return withDescription({ type: "boolean" }, schema);
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return withDescription({ type: "string", enum: [...(def.values as string[])] }, schema);
    case z.ZodFirstPartyTypeKind.ZodLiteral: {
      const value = def.value as string | number | boolean;
      const literalType = typeof value === "string" ? "string" : typeof value === "number" ? "number" : "boolean";
      return withDescription({ type: literalType, enum: [value] }, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const out: JsonSchema = { type: "array", items: convert(def.type as z.ZodTypeAny, `${path}[]`, ctx) };
      const min = def.minLength as { value: number } | null | undefined;
      const max = def.maxLength as { value: number } | null | undefined;
      if (min) out.minItems = min.value;
      if (max) out.maxItems = max.value;
      return withDescription(out, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodNullable: {
      const inner = convert(def.innerType as z.ZodTypeAny, path, ctx);
      const innerType = inner.type;
      if (typeof innerType === "string") {
        return withDescription({ ...inner, type: [innerType, "null"] }, schema);
      }
      return withDescription({ anyOf: [inner, { type: "null" }] }, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return withDescription(convert(def.innerType as z.ZodTypeAny, path, ctx), schema);
    case z.ZodFirstPartyTypeKind.ZodDefault:
    case z.ZodFirstPartyTypeKind.ZodReadonly:
    case z.ZodFirstPartyTypeKind.ZodBranded:
      return withDescription(convert((def.innerType ?? def.type) as z.ZodTypeAny, path, ctx), schema);
    case z.ZodFirstPartyTypeKind.ZodUnion: {
      const options = def.options as z.ZodTypeAny[];
      const literals: Array<string | number | boolean> = [];
      for (const option of options) {
        if (option._def.typeName === z.ZodFirstPartyTypeKind.ZodLiteral) {
          literals.push(option._def.value as string | number | boolean);
        } else if (option._def.typeName === z.ZodFirstPartyTypeKind.ZodEnum) {
          literals.push(...(option._def.values as string[]));
        } else {
          throw new UnsupportedZodTypeError("ZodUnion (non-literal member)", path);
        }
      }
      const types = [...new Set(literals.map((v) => (typeof v === "string" ? "string" : typeof v === "number" ? "number" : "boolean")))];
      return withDescription({ type: types.length === 1 ? types[0] : types, enum: literals }, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodRecord: {
      const keyType = def.keyType as z.ZodTypeAny | undefined;
      if (keyType && keyType._def.typeName !== z.ZodFirstPartyTypeKind.ZodString) {
        throw new UnsupportedZodTypeError("ZodRecord (non-string key)", path);
      }
      ctx.strictCompatible = false;
      return withDescription({ type: "object", additionalProperties: convert(def.valueType as z.ZodTypeAny, `${path}{}`, ctx) }, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodTuple: {
      const items = (def.items as z.ZodTypeAny[]).map((item, i) => convert(item, `${path}[${i}]`, ctx));
      if (def.rest) throw new UnsupportedZodTypeError("ZodTuple (rest)", path);
      return withDescription({ type: "array", prefixItems: items, items: false, minItems: items.length, maxItems: items.length }, schema);
    }
    default:
      throw new UnsupportedZodTypeError(String(typeName), path);
  }
}

export function zodToJsonSchema(schema: z.ZodTypeAny): ZodToJsonSchemaResult {
  const ctx: Ctx = { strictCompatible: true };
  const out = convert(schema, "", ctx);
  if (out.type !== "object") {
    throw new UnsupportedZodTypeError("root must be an object schema", "");
  }
  return { schema: out, strictCompatible: ctx.strictCompatible };
}
