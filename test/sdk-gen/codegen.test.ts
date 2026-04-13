import { describe, expect, test } from "bun:test";
import { generateToolCode } from "../../src/sdk-gen/codegen.ts";

describe("sdk-gen/codegen", () => {
  test("primitives + enums + arrays + nested object + $ref", () => {
    const tools = [
      {
        name: "create_issue",
        description: "Create an issue",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            priority: { enum: ["low", "medium", "high"] },
            labels: { type: "array", items: { type: "string" } },
            assignee: { $ref: "#/definitions/User" },
          },
          required: ["title"],
          definitions: {
            User: {
              type: "object",
              properties: { login: { type: "string" }, id: { type: "integer" } },
              required: ["login"],
            },
          },
        },
        outputSchema: {
          type: "object",
          properties: { number: { type: "integer" } },
          required: ["number"],
        },
      },
    ];
    const [c] = generateToolCode(tools, "github");
    expect(c).toBeDefined();
    expect(c!.fnName).toBe("createIssue");
    expect(c!.typeBase).toBe("CreateIssue");
    expect(c!.inputDecl).toContain("export interface CreateIssueArgs {");
    expect(c!.inputDecl).toContain("title: string;");
    expect(c!.inputDecl).toContain(`priority?: "low" | "medium" | "high";`);
    expect(c!.inputDecl).toContain("labels?: string[];");
    expect(c!.inputDecl).toContain("login: string;");
    expect(c!.outputDecl).toContain("export interface CreateIssueResult {");
    expect(c!.outputDecl).toContain("number: number;");
    expect(c!.fnDecl).toContain("createIssue(args: CreateIssueArgs): Promise<CreateIssueResult>");
    expect(c!.fnDecl).toContain(`callTool("github", "create_issue"`);
  });

  test("missing output schema → unknown type alias", () => {
    const [c] = generateToolCode(
      [{ name: "ping", inputSchema: { type: "object", properties: {} } }],
      "svc",
    );
    expect(c!.outputDecl).toBe("export type PingResult = unknown;");
  });

  test("object with no properties → Record<string, unknown>", () => {
    const [c] = generateToolCode(
      [{ name: "empty", inputSchema: { type: "object" } }],
      "svc",
    );
    expect(c!.inputDecl).toContain("export type EmptyArgs = Record<string, unknown>;");
  });

  test("additionalProperties object renders index signature", () => {
    const [c] = generateToolCode(
      [
        {
          name: "with_extras",
          inputSchema: {
            type: "object",
            properties: { a: { type: "string" } },
            additionalProperties: { type: "number" },
          },
        },
      ],
      "svc",
    );
    expect(c!.inputDecl).toContain("a?: string;");
    expect(c!.inputDecl).toContain("[key: string]: number;");
  });

  test("deeply nested $ref hits depth cap and falls back to unknown", () => {
    // Self-referential cycle.
    const cyclic = {
      type: "object",
      properties: { self: { $ref: "#/" } },
    } as const;
    const tools = [{ name: "cycle", inputSchema: cyclic }];
    const [c] = generateToolCode(tools, "svc", { maxDepth: 2 });
    expect(c!.inputDecl).toContain("unknown");
  });

  test("dedupes collisions across tools with same name root", () => {
    const [a, b] = generateToolCode(
      [
        { name: "do_thing", inputSchema: { type: "object" } },
        { name: "do-thing", inputSchema: { type: "object" } },
      ],
      "svc",
    );
    expect(a!.fnName).toBe("doThing");
    expect(b!.fnName).toBe("doThing2");
  });

  test("safeKey quotes non-identifier keys", () => {
    const [c] = generateToolCode(
      [
        {
          name: "weird",
          inputSchema: {
            type: "object",
            properties: { "x-y": { type: "string" } },
            required: ["x-y"],
          },
        },
      ],
      "svc",
    );
    expect(c!.inputDecl).toContain(`"x-y": string;`);
  });
});
