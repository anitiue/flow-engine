// 审查自测：flow-engine 全生命周期验证（独立于agent-b的测试）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../tools/flow.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-audit-"));
const ctx = { dataDir, agentId: "mo" };
const flowId = "audit-test";
const project = path.join(os.tmpdir(), "audit-project");

const j = (o) => JSON.parse(o);
const results = [];
const check = (name, cond, detail) => { results.push({ name, ok: !!cond, detail }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}  ${detail || ""}`); };

try {
  // 1. 建流程（九项问卷完整）
  let r = j(await executeTool("flow_new", {
    flow_id: flowId, version: "1.0.0", name: "Audit Flow",
    questionnaire: {
      purpose: "audit test flow",
      steps: ["s1", "s2", "s3"],
      agents: ["mo", "equation", "mo"],
      deliverables: ["d1", "d2", "d3"],
      acceptance: [["a1"], ["b1"], ["c1"]],
      correction_policy: "self-correct",
      completion_criteria: "all signed",
      report: { to: "owner", content: "summary", format: "text" },
      retention_days: 180,
    },
  }, ctx));
  check("flow_new 创建定义", r.created === flowId, JSON.stringify(r));

  // 2. 缺项问卷必须拒绝
  let rejected = false;
  try { await executeTool("flow_new", { flow_id: "bad", version: "1", name: "x", questionnaire: { purpose: "x" } }, ctx); } catch (e) { rejected = true; }
  check("flow_new 缺项拒绝", rejected, "");

  // 3. 绑定
  r = j(await executeTool("flow_bind", { project_path: project, flow_id: flowId }, ctx));
  check("flow_bind 绑定", r.bound === true, JSON.stringify(r));

  // 4. 建单
  r = j(await executeTool("flow_start", { flow_id: flowId, order_id: "ord-001", title: "audit order", project_path: project }, ctx));
  check("flow_start 建单", r.current_step_id === "s1", JSON.stringify(r));

  // 5. 门禁：当前环节 s1，agent mo → 应通过
  r = j(await executeTool("flow_check", { order_id: "ord-001", agent_id: "mo" }, ctx));
  check("flow_check s1/mo 通过", r.code === 0, `code=${r.code} reason=${r.reason}`);

  // 6. 错误 agent 门禁：equation 签 s1 → 应拒绝
  r = j(await executeTool("flow_check", { order_id: "ord-001", agent_id: "equation" }, ctx));
  check("flow_check s1/equation 拒绝", r.code === 11, `code=${r.code}`);

  // 7. 跳过验收条目签名 → 必须拒绝
  let signRejected = false;
  try { await executeTool("flow_sign", { order_id: "ord-001", declaration: "done", delivery_location: "loc", acceptance_results: [], agent_id: "mo" }, ctx); } catch (e) { signRejected = true; }
  check("flow_sign 空验收拒绝", signRejected, "");

  // 8. 正确签名 s1
  r = j(await executeTool("flow_sign", { order_id: "ord-001", declaration: "s1 done", delivery_location: "loc1", acceptance_results: [{ item: "a1", passed: true }], agent_id: "mo" }, ctx));
  check("flow_sign s1 成功并推进", r.signed_step === "s1" && r.next_step_id === "s2", JSON.stringify(r));

  // 9. 前置已签，当前 s2（equation）→ 通过
  r = j(await executeTool("flow_check", { order_id: "ord-001", agent_id: "equation" }, ctx));
  check("flow_check s2/equation 通过", r.code === 0, `code=${r.code}`);

  // 10. 未签 s2 直接 complete → 拒绝
  let compRejected = false;
  try { await executeTool("flow_complete", { order_id: "ord-001", acceptance_statement: "done" }, ctx); } catch (e) { compRejected = true; }
  check("flow_complete 缺签拒绝", compRejected, "");

  // 11. 签 s2、s3
  await executeTool("flow_sign", { order_id: "ord-001", declaration: "s2 done", delivery_location: "loc2", acceptance_results: [{ item: "b1", passed: true }], agent_id: "equation" }, ctx);
  r = j(await executeTool("flow_sign", { order_id: "ord-001", declaration: "s3 done", delivery_location: "loc3", acceptance_results: [{ item: "c1", passed: true }], agent_id: "mo" }, ctx));
  check("flow_sign s3 成功", r.signed_step === "s3", JSON.stringify(r));

  // 12. complete
  r = j(await executeTool("flow_complete", { order_id: "ord-001", acceptance_statement: "all done", agent_id: "mo" }, ctx));
  check("flow_complete 完成", r.status === "completed", JSON.stringify(r));

  // 13. 归档 + 文件保留
  r = j(await executeTool("flow_archive", { order_id: "ord-001", agent_id: "mo" }, ctx));
  const archivedDir = path.join(dataDir, "archive", "ord-001");
  check("flow_archive 归档", r.status === "archived" && fs.existsSync(path.join(archivedDir, "manifest.json")) && fs.existsSync(path.join(archivedDir, "events.jsonl")), JSON.stringify(r));

  // 14. 事件日志可追溯
  const events = fs.readFileSync(path.join(archivedDir, "events.jsonl"), "utf8").split("\n").filter(Boolean);
  check("事件日志完整", events.length >= 5 && events.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), `events=${events.length}`);

  // 15. 非法 order_id 路径注入拒绝：按设计返回结构化阻断，且不得写入 orders/
  r = j(await executeTool("flow_check", { order_id: "../escape", agent_id: "mo" }, ctx));
  const ordersDir = path.join(dataDir, "orders");
  const orderEntries = fs.existsSync(ordersDir) ? fs.readdirSync(ordersDir, { recursive: true }) : [];
  const noInjectedOrderPath = orderEntries.every((entry) => !entry.includes("../") && !entry.includes("escape"));
  check("路径注入拒绝", r.code === 13 && r.result === "blocked" && noInjectedOrderPath,
    `code=${r.code} result=${r.result} orders_entries=${orderEntries.length}`);

  // 16. status
  r = j(await executeTool("flow_status", { project_path: project }, ctx));
  check("flow_status 正常", r.binding?.flow_id === flowId, JSON.stringify(r).slice(0, 200));

} catch (e) {
  check("执行异常", false, e.stack || e.message);
}

const failed = results.filter((x) => !x.ok);
console.log(`\n===== 审查结果：${results.length - failed.length}/${results.length} 通过 =====`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
