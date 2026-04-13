#!/usr/bin/env bun
/**
 * Fake stdio MCP server fixture for sdk-gen tests.
 *
 * Implements just enough of the protocol (initialize + tools/list) for our
 * introspect path: low-level `Server` from @modelcontextprotocol/sdk, wired up
 * to a synthetic tools list with a mix of schema shapes to exercise codegen.
 *
 * Schema coverage:
 *   - string/number/boolean/enum primitives
 *   - nested objects with required/optional fields
 *   - arrays of objects
 *   - $ref pointing at #/definitions
 *   - `additionalProperties` object
 *   - outputSchema present on one tool, absent on another
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const tools = [
  {
    name: "create_issue",
    description: "Create a GitHub-style issue.\nSupports labels and assignees.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Issue title" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        priority: { enum: ["low", "medium", "high"] },
        assignee: { $ref: "#/definitions/User" },
      },
      required: ["title"],
      definitions: {
        User: {
          type: "object",
          properties: {
            login: { type: "string" },
            id: { type: "integer" },
          },
          required: ["login"],
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        number: { type: "integer" },
        url: { type: "string" },
      },
      required: ["number", "url"],
    },
  },
  {
    name: "list-labels",
    description: "List labels.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        extras: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
    },
  },
  {
    name: "ping",
    description: "No-arg health ping.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function main(): Promise<void> {
  const server = new Server(
    { name: "fake-mcp-server", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return {
      content: [{ type: "text", text: `ok:${req.params.name}` }],
      structuredContent: { echoed: req.params.arguments ?? null },
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[fake-mcp-server] fatal:", err);
  process.exit(1);
});
