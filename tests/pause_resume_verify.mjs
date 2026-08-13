import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../tools/flow.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-pause-"));
const project = path.join(os.tmpdir(), "flow-pause-project");
const ctx = { dataDir, agentId: "agent-a" };
const results = [];
const j = (value) => JSON.parse(value);
const check = (name, condition, detail = "") => {
  results.push(Boolean(condition));
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
};
const questionnaire = {
  purpose: "pause resume test", steps: ["build"], agents: ["agent-a"], deliverables: ["output"], acceptance: [["checked"]],
  correction_policy: "record", completion_criteria: "signed", report: { to: "owner", content: "summary", format: "text" }, retention_days: 180,
};

try {
  await executeTool("flow_new", { flow_id: "pause-flow", version: "1", name: "Pause Flow", questionnaire }, ctx);
  await executeTool("flow_bind", { project_path: project, flow_id: "pause-flow" }, ctx);
  await executeTool("flow_start", { flow_id: "pause-flow", order_id: "pause-001", title: "first order", project_path: project }, ctx);

  let result = j(await executeTool("flow_pause", { order_id: "pause-001", reason: "urgent interruption", agent_id: "agent-a" }, ctx));
  let status = j(await executeTool("flow_status", { project_path: project }, ctx));
  check("flow_pause records paused order in status", result.status === "paused" && status.order?.status === "paused" && status.paused_orders.length === 1 && status.paused_orders[0].reason === "urgent interruption", JSON.stringify(status));

  result = j(await executeTool("flow_start", { flow_id: "pause-flow", order_id: "pause-002", title: "interrupting order", project_path: project }, ctx));
  check("paused order does not block new order", result.status === "running" && result.order_id === "pause-002", JSON.stringify(result));

  let rejected = false;
  try { await executeTool("flow_resume", { order_id: "pause-001", agent_id: "agent-a" }, ctx); } catch (error) { rejected = error.message.includes("running order pause-002"); }
  check("flow_resume rejects while another running order exists", rejected);

  await executeTool("flow_close", { order_id: "pause-002", reason: "no longer needed", agent_id: "agent-a" }, ctx);
  result = j(await executeTool("flow_resume", { order_id: "pause-001", agent_id: "agent-a" }, ctx));
  status = j(await executeTool("flow_status", { project_path: project }, ctx));
  check("flow_resume succeeds without active order and restores binding", result.status === "running" && status.order?.order_id === "pause-001" && status.order.status === "running", JSON.stringify(status));

  result = j(await executeTool("flow_close", { order_id: "pause-001", reason: "cancelled", agent_id: "agent-a" }, ctx));
  const closedManifest = JSON.parse(fs.readFileSync(path.join(dataDir, "archive", "pause-001", "manifest.json"), "utf8"));
  const bindings = JSON.parse(fs.readFileSync(path.join(dataDir, "bindings.json"), "utf8"));
  const events = fs.readFileSync(path.join(dataDir, "archive", "pause-001", "events.jsonl"), "utf8");
  check("flow_close archives closed order and clears binding", result.status === "closed" && closedManifest.status === "closed" && Boolean(closedManifest.closed_at) && bindings[status.project_path].order_id === null && events.includes('"type":"closed"'), JSON.stringify(result));
} catch (error) {
  check("test execution", false, error.stack || error.message);
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n===== Pause/resume verification: ${failed ? "FAILED" : "PASSED"} (${results.length - failed}/${results.length}) =====`);
process.exit(failed ? 1 : 0);
