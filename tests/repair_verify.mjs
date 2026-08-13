import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../tools/flow.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-repair-"));
const project = path.join(os.tmpdir(), "flow-repair-project");
const ctx = { dataDir, agentId: "agent-a" };
const parse = JSON.parse;
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const rejects = async (run, contains) => {
  try { await run(); return false; } catch (error) { return !contains || error.message.includes(contains); }
};
const questionnaire = (agents = ["agent-a"], steps = ["review"], acceptance = [["checked"]]) => ({
  purpose: "repair verification", steps, agents, deliverables: steps.map((step) => `${step} output`), acceptance,
  correction_policy: "record corrections", completion_criteria: "all signed", report: { to: "owner", content: "summary", format: "text" }, retention_days: 180,
});

try {
  const list = parse(await executeTool("flow_list", {}, ctx));
  check("pluginDir omitted still installs example", list.flows.some((flow) => flow.flow_id === "example"));

  await executeTool("flow_new", { flow_id: "repair-a", version: "1", name: "Repair A", questionnaire: questionnaire() }, ctx);
  await executeTool("flow_new", { flow_id: "repair-b", version: "1", name: "Repair B", questionnaire: questionnaire() }, ctx);
  await executeTool("flow_bind", { project_path: project, flow_id: "repair-a" }, ctx);
  await executeTool("flow_start", { flow_id: "repair-a", order_id: "repair-1", title: "first", project_path: project }, ctx);
  check("running order blocks rebinding", await rejects(() => executeTool("flow_bind", { project_path: project, flow_id: "repair-b" }, ctx), "running order repair-1"));
  check("running order blocks a second start", await rejects(() => executeTool("flow_start", { flow_id: "repair-a", order_id: "repair-2", title: "second", project_path: project }, ctx), "running order: repair-1"));

  await executeTool("flow_sign", { order_id: "repair-1", declaration: "done", delivery_location: "test", acceptance_results: [{ item: "checked", passed: true }], agent_id: "agent-a" }, ctx);
  check("final signed step cannot be signed twice", await rejects(() => executeTool("flow_sign", { order_id: "repair-1", declaration: "again", delivery_location: "test", acceptance_results: [{ item: "checked", passed: true }], agent_id: "agent-a" }, ctx), "already signed"));
  await executeTool("flow_complete", { order_id: "repair-1", acceptance_statement: "accepted", agent_id: "agent-a" }, ctx);
  check("completed order rejects correction", await rejects(() => executeTool("flow_correct", { order_id: "repair-1", affected_step_id: "review", correction: "late", agent_id: "agent-a" }, ctx), "order is completed"));
  check("completed order rejects escalation", await rejects(() => executeTool("flow_escalate", { order_id: "repair-1", reason: "late", agent_id: "agent-a" }, ctx), "order is completed"));
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n===== Repair verification: ${failures.length ? "FAILED" : "PASSED"} =====`);
process.exit(failures.length ? 1 : 0);
