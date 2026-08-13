import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import guard from "../extensions/guard.js";
import { executeTool } from "../tools/flow.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-guard-"));
const cwd = path.join(os.tmpdir(), "flow-guard-workspace");
const project = path.join(cwd, ".flow-test-project");
const ctx = { dataDir, cwd, agentId: "agent-a" };
const handlers = new Map();
const pi = { on(type, handler) { handlers.set(type, handler); } };
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const call = (type, event, context = ctx) => handlers.get(type)(event, context);
const questionnaire = {
  purpose: "guard event contract test",
  steps: ["first", "second"],
  agents: ["agent-a", "agent-b"],
  deliverables: ["first output", "second output"],
  acceptance: [["first checked"], ["second checked"]],
  correction_policy: "record corrections",
  completion_criteria: "all signed",
  report: { to: "owner", content: "summary", format: "text" },
  retention_days: 180,
};

try {
  guard(pi);
  await executeTool("flow_new", { flow_id: "guard-flow", version: "1", name: "Guard Flow", questionnaire }, ctx);
  await executeTool("flow_bind", { project_path: project, flow_id: "guard-flow" }, ctx);

  const originalMessages = [{ role: "user", content: "continue work" }];
  let result = call("context", { type: "context", messages: originalMessages });
  check("context event injects unstarted binding notice", Array.isArray(result?.messages)
    && result.messages.length === 2
    && result.messages[0] === originalMessages[0]
    && result.messages[1].content.includes("尚未建单"));

  result = call("tool_call", { type: "tool_call", toolName: "subagent", input: { agent: "agent-b", task: "implement second step" } });
  check("tool_call without order blocks", result?.block === true && result.reason.includes("尚未建单"));

  await executeTool("flow_start", { flow_id: "guard-flow", order_id: "guard-001", title: "guard order", project_path: project }, ctx);
  await executeTool("flow_pause", { order_id: "guard-001", reason: "interrupted", agent_id: "agent-a" }, ctx);
  result = call("context", { type: "context", messages: originalMessages });
  check("context event shows paused-order hint without active injection", result?.messages?.[1]?.content.includes("另有 1 张暂停单"));
  result = call("tool_call", { type: "tool_call", toolName: "subagent", input: { agent: "agent-b", task: "paused work" } });
  check("tool_call with only paused orders blocks with resume/new guidance", result?.block === true && result.reason.includes("先恢复或新建订单"));
  await executeTool("flow_resume", { order_id: "guard-001", agent_id: "agent-a" }, ctx);
  const manifestPath = path.join(dataDir, "orders", "guard-001", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.current_step_id = "second";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  result = call("tool_call", { type: "tool_call", toolName: "subagent", input: { agent: "agent-b", task: "implement second step" } });
  check("tool_call with missing prerequisite blocks", result?.block === true && result.reason.includes("Prerequisite first"));
  manifest.current_step_id = "first";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await executeTool("flow_sign", {
    order_id: "guard-001", declaration: "first done", delivery_location: "first-output",
    acceptance_results: [{ item: "first checked", passed: true }], agent_id: "agent-a",
  }, ctx);
  const event = { type: "tool_call", toolName: "subagent", input: { agent: "agent-b", task: "implement second step" } };
  result = call("tool_call", event);
  check("tool_call appends hard facts when gate passes", result === undefined
    && event.input.task.includes("流程硬事实")
    && event.input.task.includes("当前环节：second"));

  result = call("tool_call", { type: "tool_call", toolName: "subagent", input: { agent: "agent-b", task: "outside project" } }, { dataDir, cwd: path.join(os.tmpdir(), "unbound-workspace") });
  check("unbound cwd is untouched", result === undefined);
} catch (error) {
  check("test execution", false, error.stack || error.message);
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n===== Guard mock test: ${failures.length ? "FAILED" : "PASSED"} (${7 - failures.length}/7) =====`);
process.exit(failures.length ? 1 : 0);
