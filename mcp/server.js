#!/usr/bin/env node
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { definitions, executeTool } from "../tools/flow.js";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(serverDir, "..");
const dataDir = path.resolve(process.env.FLOW_ENGINE_DATA_DIR || path.join(os.homedir(), ".flow-engine"));
const agentId = process.env.FLOW_ENGINE_AGENT_ID || "mcp-user";
const ctx = { dataDir, agentId, pluginDir };

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function error(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolDefinitions() {
  return Object.entries(definitions).map(([name, definition]) => ({
    name,
    description: definition.description,
    inputSchema: definition.parameters,
  }));
}

async function handle(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return error(null, -32600, "Invalid Request.");
  }
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return error(request.id, -32600, "Invalid Request.");
  }

  const isNotification = request.id === undefined;
  let response;
  try {
    switch (request.method) {
      case "initialize":
        response = {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: request.params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "flow-engine-mcp", version: "1.0.0" },
          },
        };
        break;
      case "notifications/initialized":
        return null;
      case "ping":
        response = { jsonrpc: "2.0", id: request.id, result: {} };
        break;
      case "tools/list":
        response = { jsonrpc: "2.0", id: request.id, result: { tools: toolDefinitions() } };
        break;
      case "tools/call": {
        const name = request.params?.name;
        const input = request.params?.arguments;
        if (typeof name !== "string") {
          response = error(request.id, -32602, "tools/call requires a string name.");
          break;
        }
        if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) {
          response = error(request.id, -32602, "tools/call arguments must be an object.");
          break;
        }
        const result = await executeTool(name, input || {}, ctx);
        response = { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: result }] } };
        break;
      }
      default:
        response = error(request.id, -32601, `Method not found: ${request.method}.`);
    }
  } catch (exception) {
    response = error(request.id, -32603, exception instanceof Error ? exception.message : String(exception));
  }
  return isNotification ? null : response;
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send(error(null, -32700, "Parse error."));
    return;
  }
  const response = await handle(request);
  if (response) send(response);
});
