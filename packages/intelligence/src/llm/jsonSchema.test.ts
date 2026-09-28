import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentVoteSchema, DevilsAdvocateOutputSchema, ExecutionAgentOutputSchema, MarketRegimeAgentOutputSchema } from "@yz/core";
import { UnsupportedZodTypeError, zodToJsonSchema } from "./jsonSchema.js";

describe("zodToJsonSchema", () => {
  it("converts objects with all supported primitive kinds", () => {
    const schema = z.object({
      name: z.string().max(10).describe("a name"),
      n: z.number().min(0).max(1),
      i: z.number().int(),
      flag: z.boolean(),
      kind: z.enum(["a", "b"]),
      lit: z.literal("x"),
      list: z.array(z.string()).max(3),
      maybe: z.string().nullable(),
      opt: z.number().optional(),
      union: z.union([z.literal("p"), z.literal("q")]),
      rec: z.record(z.string(), z.number()),
      tup: z.tuple([z.number(), z.number()]),
    });
    const { schema: out, strictCompatible } = zodToJsonSchema(schema);
    expect(out.type).toBe("object");
    expect(out.additionalProperties).toBe(false);
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.name).toEqual({ type: "string", maxLength: 10, description: "a name" });
    expect(props.n).toEqual({ type: "number", minimum: 0, maximum: 1 });
    expect(props.i).toEqual({ type: "integer" });
    expect(props.flag).toEqual({ type: "boolean" });
    expect(props.kind).toEqual({ type: "string", enum: ["a", "b"] });
    expect(props.lit).toEqual({ type: "string", enum: ["x"] });
    expect(props.list).toEqual({ type: "array", items: { type: "string" }, maxItems: 3 });
    expect(props.maybe).toEqual({ type: ["string", "null"] });
    expect(props.opt).toEqual({ type: "number" });
    expect(props.union).toEqual({ type: "string", enum: ["p", "q"] });
    expect(props.rec).toEqual({ type: "object", additionalProperties: { type: "number" } });
    expect(props.tup).toMatchObject({ type: "array", minItems: 2, maxItems: 2 });
    expect(out.required).toEqual(["name", "n", "i", "flag", "kind", "lit", "list", "maybe", "union", "rec", "tup"]);
    expect(strictCompatible).toBe(false); // has optional + record
  });

  it("marks fully-required schemas as strict compatible", () => {
    expect(zodToJsonSchema(z.object({ a: z.string(), b: z.number().nullable() })).strictCompatible).toBe(true);
  });

  it("converts the core agent schemas", () => {
    for (const s of [AgentVoteSchema, MarketRegimeAgentOutputSchema, DevilsAdvocateOutputSchema, ExecutionAgentOutputSchema]) {
      const out = zodToJsonSchema(s).schema;
      expect(out.type).toBe("object");
    }
    const exec = zodToJsonSchema(ExecutionAgentOutputSchema).schema.properties as Record<string, Record<string, unknown>>;
    expect(exec.staging).toMatchObject({ type: ["object", "null"] });
  });

  it("throws on unsupported types instead of degrading", () => {
    expect(() => zodToJsonSchema(z.object({ d: z.date() }))).toThrow(UnsupportedZodTypeError);
    expect(() => zodToJsonSchema(z.object({ u: z.union([z.string(), z.number()]) }))).toThrow(UnsupportedZodTypeError);
    expect(() => zodToJsonSchema(z.string())).toThrow(UnsupportedZodTypeError);
  });
});
