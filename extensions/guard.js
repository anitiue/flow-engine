import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  checkGate, deriveState, ensureStore, findPausedOrdersForProject, findRunningOrderForProject,
  getDataDir, loadBindings, loadOrder, normalizedProject, readEvents,
} from "../lib/runtime.js";

const SUBAGENT_TOOLS = new Set(["subagent", "subagent_create", "subagent_run", "agent_subagent"]);

function projectFromContext(ctx) {
  return typeof ctx?.cwd === "string" && ctx.cwd.trim() ? ctx.cwd : null;
}

function boundProject(paths, cwd) {
  const project = normalizedProject(cwd);
  const bindings = loadBindings(paths);
  const matches = Object.keys(bindings)
    .map((key) => ({ key, normalized: normalizedProject(key), binding: bindings[key] }))
    .filter(({ normalized }) => project === normalized || normalized.startsWith(`${project}\\`))
    .sort((a, b) => b.normalized.length - a.normalized.length);
  const match = matches[0];
  return { project, binding: match?.binding || null, bindingProject: match?.key || null, bindings };
}

function toolNameFromEvent(event) {
  return event?.toolName || event?.name || event?.toolCall?.name || event?.toolCall?.toolName || "";
}

function argsFromEvent(event) {
  if (event?.input && typeof event.input === "object") return event.input;
  if (event && event.args && typeof event.args === "object") return event.args;
  if (event?.arguments && typeof event.arguments === "object") return event.arguments;
  if (event?.toolCall?.arguments && typeof event.toolCall.arguments === "object") return event.toolCall.arguments;
  return null;
}

function promptField(args) {
  if (!args) return null;
  for (const key of ["task", "prompt", "message", "instructions"]) if (typeof args[key] === "string") return key;
  return null;
}

function stateLine(order, state, gate) {
  const step = state.steps.find((item) => item.id === state.currentStepId);
  const prerequisite = gate.code === 0 ? "已签名" : `未通过（${gate.reason}）`;
  return `【流程】绑定：${order.definition.flow_id} | 订单：${order.manifest.order_id} | 当前环节：${step?.name || state.currentStepId}（${step?.agent || "?"}）| 前置：${prerequisite}`;
}

function hardFacts(order, state, gate) {
  const step = state.steps.find((item) => item.id === state.currentStepId);
  const acceptance = (step?.acceptance || []).map((item, index) => `${index + 1}. ${item}`).join("\n");
  return [
    "\n\n--- 流程硬事实（Flow Engine 自动附加，请勿改写） ---",
    `流程：${order.definition.flow_id} v${order.definition.version}`,
    `订单：${order.manifest.order_id}`,
    `当前环节：${step?.id} / ${step?.name}，执行者：${step?.agent}`,
    `前置签名状态：${gate.code === 0 ? "已通过" : gate.reason}`,
    `本环节验收条目：\n${acceptance}`,
    `交付格式：${step?.deliverable}`,
    "完成后请提交完成声明、交付位置，以及每条验收条目的逐项结论。",
    "--- 流程硬事实结束 ---",
  ].join("\n");
}

function storeContext(ctx) {
  return ensureStore(getDataDir(ctx));
}

export default function guard(pi) {
  // context: inject the current bound order state before every LLM call.
  pi.on("context", (event, ctx) => {
    const projectPath = projectFromContext(ctx);
    if (!projectPath) return undefined;
    try {
      const paths = storeContext(ctx);
      const { project, binding, bindingProject } = boundProject(paths, projectPath);
      if (!binding) return undefined;
      const boundPath = bindingProject || project;
      const runningOrderId = findRunningOrderForProject(paths, boundPath);
      if (!runningOrderId) {
        const pausedOrders = findPausedOrdersForProject(paths, boundPath);
        const content = pausedOrders.length
          ? `【流程】另有 ${pausedOrders.length} 张暂停单（flow_status 查看）。`
          : "【流程】当前项目已绑定流程，但尚未建单：请先 flow_start 建单。";
        return { messages: [...(Array.isArray(event?.messages) ? event.messages : []), { role: "system", content }] };
      }
      const order = loadOrder(paths, runningOrderId);
      const events = readEvents(order.directory);
      const state = deriveState(order.manifest, order.definition, events);
      const currentStep = state.steps.find((step) => step.id === state.currentStepId);
      const gate = checkGate({ definition: order.definition, manifest: order.manifest, events, agent: currentStep?.agent || "" });
      return {
        messages: [...(Array.isArray(event?.messages) ? event.messages : []), { role: "system", content: stateLine(order, state, gate) }],
      };
    } catch {
      return undefined;
    }
  });

  // tool_call: guard subagent dispatches. Unbound projects are deliberately untouched.
  pi.on("tool_call", (event, ctx) => {
    if (!SUBAGENT_TOOLS.has(toolNameFromEvent(event))) return undefined;
    const projectPath = projectFromContext(ctx);
    if (!projectPath) return undefined;
    try {
      const paths = storeContext(ctx);
      const { project, binding, bindingProject } = boundProject(paths, projectPath);
      if (!binding) return undefined;
      const boundPath = bindingProject || project;
      const runningOrderId = findRunningOrderForProject(paths, boundPath);
      if (!runningOrderId) {
        const pausedOrders = findPausedOrdersForProject(paths, boundPath);
        if (pausedOrders.length) return { block: true, reason: `项目有暂停单 ${pausedOrders.length} 张，先恢复或新建订单。` };
        return { block: true, reason: "流程已绑定但尚未建单，请先调用 flow_start 建单。" };
      }
      const order = loadOrder(paths, runningOrderId);
      const events = readEvents(order.directory);
      const state = deriveState(order.manifest, order.definition, events);
      const currentStep = state.steps.find((step) => step.id === state.currentStepId);
      const gate = checkGate({ definition: order.definition, manifest: order.manifest, events, agent: currentStep?.agent || "" });
      if (gate.code !== 0) return { block: true, reason: `流程派发被门禁拦截（${gate.code}）：${gate.reason}` };
      const args = argsFromEvent(event); const field = promptField(args);
      if (!args || !field) return { block: true, reason: "流程派发缺少可附加硬事实的任务文本（task/prompt/message/instructions）。" };
      args[field] = `${args[field]}${hardFacts(order, state, gate)}`;
      return undefined;
    } catch (error) {
      return { block: true, reason: `流程保障层无法确认订单状态，已拦截派发：${error.message}` };
    }
  });
}

export const _testing = { projectFromContext, boundProject, toolNameFromEvent, argsFromEvent, promptField, hardFacts };
