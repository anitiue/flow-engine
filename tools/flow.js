import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentId, appendEvent, assertId, assertText, checkGate, clearOrderBindings, deriveState, ensureStore,
  findRunningOrderForProject, flowFile, getDataDir, getBoundProject, jsonResult, loadBindings,
  loadFlow, loadOrder, normalizedProject, orderStatus, readDefinitionFile, readEvents,
  saveOrderManifest, statusSummary, validateDefinition, writeJsonAtomic,
} from "../lib/runtime.js";

function store(ctx) {
  const dataDir = getDataDir(ctx);
  const paths = ensureStore(dataDir);
  const pluginDir = ctx?.pluginDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const example = path.join(pluginDir, "flows", "example.yaml");
  const target = flowFile(paths, "example");
  if (!fs.existsSync(target) && fs.existsSync(example)) fs.copyFileSync(example, target);
  return paths;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function questionnaireToDefinition(input) {
  const q = requireObject(input.questionnaire, "questionnaire");
  const required = ["purpose", "steps", "agents", "deliverables", "acceptance", "correction_policy", "completion_criteria", "report", "retention_days"];
  const missing = required.filter((key) => q[key] === undefined || q[key] === null || q[key] === "" || (Array.isArray(q[key]) && q[key].length === 0));
  if (missing.length) throw new Error(`flow_new stopped: questionnaire is missing ${missing.join(", ")}. All nine items are required.`);
  if (!Array.isArray(q.steps) || !Array.isArray(q.agents) || !Array.isArray(q.deliverables) || !Array.isArray(q.acceptance)) throw new Error("questionnaire steps, agents, deliverables, and acceptance must be arrays.");
  if (q.steps.length !== q.agents.length || q.steps.length !== q.deliverables.length || q.steps.length !== q.acceptance.length) throw new Error("questionnaire steps, agents, deliverables, and acceptance must have matching lengths.");
  const definition = {
    flow_id: input.flow_id,
    version: input.version,
    name: input.name,
    purpose: q.purpose,
    report: q.report,
    correction_policy: q.correction_policy,
    completion_criteria: q.completion_criteria,
    retention_days: q.retention_days,
    steps: q.steps.map((item, index) => ({
      id: typeof item === "object" ? item.id : item,
      name: typeof item === "object" ? item.name : item,
      agent: q.agents[index],
      deliverable: q.deliverables[index],
      acceptance: q.acceptance[index],
      ...(index === q.steps.length - 1 ? { is_final: true } : {}),
    })),
  };
  return validateDefinition(definition);
}

function formatGate(order, gate) {
  const state = gate.state;
  return {
    order_id: order.manifest.order_id,
    title: order.manifest.title,
    current_step: gate.step ? { id: gate.step.id, name: gate.step.name, agent: gate.step.agent } : null,
    code: gate.code,
    result: gate.code === 0 ? "passed" : "blocked",
    reason: gate.reason,
    prerequisites: state.steps.map((step) => ({ id: step.id, name: step.name, signed: Boolean(step.signed), signed_by: step.signed?.agent || null, signed_at: step.signed?.timestamp || null })),
    acceptance: gate.step?.acceptance || [],
    deliverable: gate.step?.deliverable || null,
  };
}

export const definitions = {
  flow_list: {
    description: "List the installed workflow definitions and their step summaries.", parameters: { type: "object", properties: {}, additionalProperties: false },
    execute(input, ctx) {
      const paths = store(ctx);
      const flows = fs.readdirSync(paths.flows).filter((name) => name.endsWith(".yaml")).map((name) => {
        const definition = validateDefinition(readDefinitionFile(path.join(paths.flows, name)));
        return { flow_id: definition.flow_id, version: definition.version, name: definition.name, purpose: definition.purpose, steps: definition.steps.map((step) => ({ id: step.id, name: step.name, agent: step.agent })) };
      });
      return jsonResult({ flows });
    },
  },
  flow_new: {
    description: "Create a workflow definition after all nine questionnaire answers are supplied.", parameters: { type: "object", properties: { flow_id: { type: "string" }, version: { type: "string" }, name: { type: "string" }, questionnaire: { type: "object" } }, required: ["flow_id", "version", "name", "questionnaire"], additionalProperties: false },
    execute(input, ctx) {
      const paths = store(ctx); const definition = questionnaireToDefinition(input); const file = flowFile(paths, definition.flow_id);
      if (fs.existsSync(file)) throw new Error(`Flow already exists: ${definition.flow_id}.`);
      fs.writeFileSync(file, `${JSON.stringify(definition, null, 2)}\n`, "utf8");
      return jsonResult({ created: definition.flow_id, version: definition.version, file });
    },
  },
  flow_start: {
    description: "Start an order from a flow definition and freeze its definition snapshot.", parameters: { type: "object", properties: { flow_id: { type: "string" }, order_id: { type: "string" }, title: { type: "string" }, project_path: { type: "string" } }, required: ["flow_id", "order_id", "title", "project_path"], additionalProperties: false },
    execute(input, ctx) {
      const paths = store(ctx); const flow = loadFlow(paths, input.flow_id); const orderId = assertId(input.order_id, "order_id"); const title = assertText(input.title, "title"); const project = normalizedProject(input.project_path); const directory = path.join(paths.orders, orderId);
      if (fs.existsSync(directory) || fs.existsSync(path.join(paths.archive, orderId))) throw new Error(`Order already exists: ${orderId}.`);
      const { binding, bindings } = getBoundProject(paths, project);
      if (binding && binding.flow_id !== flow.flow_id) throw new Error(`Project is bound to ${binding.flow_id}, not ${flow.flow_id}.`);
      if (binding?.order_id) {
        const boundOrderDirectory = path.join(paths.orders, binding.order_id);
        const archivedOrderDirectory = path.join(paths.archive, binding.order_id);
        if (fs.existsSync(boundOrderDirectory)) {
          if (orderStatus(paths, binding.order_id) === "running") throw new Error(`Project already has running order: ${binding.order_id}.`);
        } else if (!fs.existsSync(archivedOrderDirectory)) {
          throw new Error(`Bound order reference is corrupt: ${binding.order_id} is not present in orders or archive.`);
        }
      }
      const runningOrderId = findRunningOrderForProject(paths, project);
      if (runningOrderId) throw new Error(`Project already has running order: ${runningOrderId}.`);
      fs.mkdirSync(directory, { recursive: false });
      fs.writeFileSync(path.join(directory, "definition.yaml"), `${JSON.stringify(flow, null, 2)}\n`, "utf8");
      const manifest = { order_id: orderId, flow_id: flow.flow_id, flow_version: flow.version, title, project_path: project, status: "running", current_step_id: flow.steps[0].id, created_at: new Date().toISOString(), created_by: agentId(ctx, input) };
      saveOrderManifest(directory, manifest); appendEvent(directory, "started", { flow_id: flow.flow_id, flow_version: flow.version, title, project_path: project }, agentId(ctx, input));
      if (binding) { bindings[project] = { ...binding, order_id: orderId, updated_at: new Date().toISOString() }; writeJsonAtomic(paths.bindings, bindings); }
      return jsonResult({ order_id: orderId, status: "running", current_step_id: manifest.current_step_id, definition_frozen: true });
    },
  },
  flow_check: {
    description: "Check an order gate for the calling agent. code 0 passes; non-zero blocks with a reason.", parameters: { type: "object", properties: { order_id: { type: "string" }, agent_id: { type: "string" } }, required: ["order_id"], additionalProperties: false },
    execute(input, ctx) {
      let order;
      try { order = loadOrder(store(ctx), input.order_id); }
      catch (error) { return jsonResult({ order_id: input?.order_id || null, code: 13, result: "blocked", reason: error.message }); }
      return jsonResult(formatGate(order, checkGate({ definition: order.definition, manifest: order.manifest, events: readEvents(order.directory), agent: agentId(ctx, input) })));
    },
  },
  flow_sign: {
    description: "Record a current-step signature with a declaration, delivery location, and a result for every acceptance item.", parameters: { type: "object", properties: { order_id: { type: "string" }, declaration: { type: "string" }, delivery_location: { type: "string" }, acceptance_results: { type: "array", items: { type: "object" } }, agent_id: { type: "string" } }, required: ["order_id", "declaration", "delivery_location", "acceptance_results"], additionalProperties: false },
    execute(input, ctx) {
      const order = loadOrder(store(ctx), input.order_id); const agent = agentId(ctx, input); const events = readEvents(order.directory); const gate = checkGate({ definition: order.definition, manifest: order.manifest, events, agent });
      if (gate.code !== 0) throw new Error(`Cannot sign: ${gate.reason}`);
      const results = input.acceptance_results;
      if (!Array.isArray(results) || results.length !== gate.step.acceptance.length) throw new Error("acceptance_results must include one result for every acceptance item.");
      const checked = results.map((result, index) => { requireObject(result, "acceptance result"); if (result.item !== gate.step.acceptance[index] || typeof result.passed !== "boolean") throw new Error(`acceptance_results[${index}] must match its acceptance item and include boolean passed.`); if (!result.passed && !assertText(result.reason, `acceptance_results[${index}].reason`)) throw new Error("A failed acceptance item requires a reason."); return { item: result.item, passed: result.passed, ...(result.reason ? { reason: result.reason } : {}) }; });
      if (checked.some((result) => !result.passed)) throw new Error("Cannot sign while any acceptance item is failed.");
      appendEvent(order.directory, "signed", { step_id: gate.step.id, declaration: assertText(input.declaration, "declaration"), delivery_location: assertText(input.delivery_location, "delivery_location"), acceptance_results: checked }, agent);
      const state = deriveState(order.manifest, order.definition, readEvents(order.directory));
      const signedIndex = state.steps.findIndex((step) => step.id === gate.step.id);
      const nextStep = state.steps.slice(signedIndex + 1).find((step) => !step.signed);
      order.manifest.current_step_id = nextStep?.id || gate.step.id;
      saveOrderManifest(order.directory, order.manifest);
      return jsonResult({ order_id: order.manifest.order_id, signed_step: gate.step.id, next_step_id: order.manifest.current_step_id });
    },
  },
  flow_correct: {
    description: "Append a correction record to an active order.", parameters: { type: "object", properties: { order_id: { type: "string" }, affected_step_id: { type: "string" }, correction: { type: "string" }, agent_id: { type: "string" } }, required: ["order_id", "affected_step_id", "correction"], additionalProperties: false },
    execute(input, ctx) { const order = loadOrder(store(ctx), input.order_id); const state = deriveState(order.manifest, order.definition, readEvents(order.directory)); if (state.status !== "running") throw new Error(`Cannot correct: order is ${state.status}.`); assertId(input.affected_step_id, "affected_step_id"); if (!order.definition.steps.some((step) => step.id === input.affected_step_id)) throw new Error("affected_step_id is not in this order."); appendEvent(order.directory, "corrected", { affected_step_id: input.affected_step_id, correction: assertText(input.correction, "correction") }, agentId(ctx, input)); return jsonResult({ order_id: input.order_id, corrected: input.affected_step_id }); },
  },
  flow_escalate: {
    description: "Append a blocker escalation for the responsible owner.", parameters: { type: "object", properties: { order_id: { type: "string" }, reason: { type: "string" }, agent_id: { type: "string" } }, required: ["order_id", "reason"], additionalProperties: false },
    execute(input, ctx) { const order = loadOrder(store(ctx), input.order_id); const state = deriveState(order.manifest, order.definition, readEvents(order.directory)); if (state.status !== "running") throw new Error(`Cannot escalate: order is ${state.status}.`); appendEvent(order.directory, "escalated", { reason: assertText(input.reason, "reason") }, agentId(ctx, input)); return jsonResult({ order_id: input.order_id, escalated: true }); },
  },
  flow_complete: {
    description: "Mark a fully signed order as finally accepted and completed.", parameters: { type: "object", properties: { order_id: { type: "string" }, acceptance_statement: { type: "string" }, agent_id: { type: "string" } }, required: ["order_id", "acceptance_statement"], additionalProperties: false },
    execute(input, ctx) { const order = loadOrder(store(ctx), input.order_id); const events = readEvents(order.directory); const state = deriveState(order.manifest, order.definition, events); if (state.status !== "running") throw new Error(`Order is already ${state.status}.`); const unsigned = state.steps.find((step) => !step.signed); if (unsigned) throw new Error(`Cannot complete: ${unsigned.id} (${unsigned.name}) is not signed.`); appendEvent(order.directory, "completed", { acceptance_statement: assertText(input.acceptance_statement, "acceptance_statement") }, agentId(ctx, input)); order.manifest.status = "completed"; order.manifest.completed_at = new Date().toISOString(); saveOrderManifest(order.directory, order.manifest); return jsonResult({ order_id: input.order_id, status: "completed", report: order.definition.report }); },
  },
  flow_pause: {
    description: "Pause a running order with an accountable reason, removing it from active dispatch safeguards.", parameters: { type: "object", properties: { order_id: { type: "string" }, reason: { type: "string" }, agent_id: { type: "string" } }, required: ["order_id", "reason"], additionalProperties: false },
    execute(input, ctx) { const order = loadOrder(store(ctx), input.order_id); if (deriveState(order.manifest, order.definition, readEvents(order.directory)).status !== "running") throw new Error(`Cannot pause: order is ${order.manifest.status}.`); const reason = assertText(input.reason, "reason"); appendEvent(order.directory, "paused", { reason }, agentId(ctx, input)); order.manifest.status = "paused"; order.manifest.paused_at = new Date().toISOString(); order.manifest.pause_reason = reason; saveOrderManifest(order.directory, order.manifest); return jsonResult({ order_id: order.manifest.order_id, status: "paused", paused_at: order.manifest.paused_at }); },
  },
  flow_resume: {
    description: "Resume a paused order when its project has no other running order.", parameters: { type: "object", properties: { order_id: { type: "string" }, agent_id: { type: "string" } }, required: ["order_id"], additionalProperties: false },
    execute(input, ctx) { const paths = store(ctx); const order = loadOrder(paths, input.order_id); if (deriveState(order.manifest, order.definition, readEvents(order.directory)).status !== "paused") throw new Error(`Cannot resume: order is ${order.manifest.status}.`); const runningOrderId = findRunningOrderForProject(paths, order.manifest.project_path); if (runningOrderId) throw new Error(`Cannot resume: project already has running order ${runningOrderId}.`); appendEvent(order.directory, "resumed", {}, agentId(ctx, input)); order.manifest.status = "running"; delete order.manifest.paused_at; delete order.manifest.pause_reason; saveOrderManifest(order.directory, order.manifest); const { project, binding, bindings } = getBoundProject(paths, order.manifest.project_path); if (binding) { bindings[project] = { ...binding, order_id: order.manifest.order_id, updated_at: new Date().toISOString() }; writeJsonAtomic(paths.bindings, bindings); } return jsonResult({ order_id: order.manifest.order_id, status: "running" }); },
  },
  flow_close: {
    description: "Close a running or paused order with a reason and move it into the archive.", parameters: { type: "object", properties: { order_id: { type: "string" }, reason: { type: "string" }, agent_id: { type: "string" } }, required: ["order_id", "reason"], additionalProperties: false },
    execute(input, ctx) { const paths = store(ctx); const order = loadOrder(paths, input.order_id); const state = deriveState(order.manifest, order.definition, readEvents(order.directory)); if (!["running", "paused"].includes(state.status)) throw new Error(`Cannot close: order is ${state.status}.`); const reason = assertText(input.reason, "reason"); appendEvent(order.directory, "closed", { reason }, agentId(ctx, input)); order.manifest.status = "closed"; order.manifest.closed_at = new Date().toISOString(); order.manifest.close_reason = reason; saveOrderManifest(order.directory, order.manifest); fs.renameSync(order.directory, path.join(paths.archive, order.manifest.order_id)); clearOrderBindings(paths, order.manifest.order_id); return jsonResult({ order_id: order.manifest.order_id, status: "closed", closed_at: order.manifest.closed_at }); },
  },
  flow_archive: {
    description: "Archive a completed order, retaining its manifest and event history.", parameters: { type: "object", properties: { order_id: { type: "string" }, agent_id: { type: "string" } }, required: ["order_id"], additionalProperties: false },
    execute(input, ctx) { const paths = store(ctx); const order = loadOrder(paths, input.order_id); if (order.manifest.status !== "completed") throw new Error("Only completed orders may be archived."); appendEvent(order.directory, "archived", {}, agentId(ctx, input)); order.manifest.status = "archived"; order.manifest.archived_at = new Date().toISOString(); saveOrderManifest(order.directory, order.manifest); fs.renameSync(order.directory, path.join(paths.archive, order.manifest.order_id)); clearOrderBindings(paths, order.manifest.order_id); return jsonResult({ order_id: input.order_id, status: "archived", retention_days: 180 }); },
  },
  flow_bind: {
    description: "Bind a project path to a flow definition.", parameters: { type: "object", properties: { project_path: { type: "string" }, flow_id: { type: "string" } }, required: ["project_path", "flow_id"], additionalProperties: false },
    execute(input, ctx) { const paths = store(ctx); const flow = loadFlow(paths, input.flow_id); const project = normalizedProject(input.project_path); const bindings = loadBindings(paths); const boundOrderId = bindings[project]?.order_id; if (boundOrderId && orderStatus(paths, boundOrderId) === "running") throw new Error(`Cannot replace binding: project has running order ${boundOrderId}.`); const runningOrderId = findRunningOrderForProject(paths, project); if (runningOrderId) throw new Error(`Cannot replace binding: project has running order ${runningOrderId}.`); bindings[project] = { flow_id: flow.flow_id, bound_at: new Date().toISOString(), order_id: null }; writeJsonAtomic(paths.bindings, bindings); return jsonResult({ project_path: project, flow_id: flow.flow_id, bound: true }); },
  },
  flow_unbind: {
    description: "Remove a project-to-flow binding when it has no running order.", parameters: { type: "object", properties: { project_path: { type: "string" } }, required: ["project_path"], additionalProperties: false },
    execute(input, ctx) { const paths = store(ctx); const { project, binding, bindings } = getBoundProject(paths, input.project_path); if (!binding) throw new Error("Project has no flow binding."); if (binding.order_id) { const summary = statusSummary(paths, project); if (summary.order?.status === "running") throw new Error("Cannot unbind while the bound order is running."); } delete bindings[project]; writeJsonAtomic(paths.bindings, bindings); return jsonResult({ project_path: project, unbound: true }); },
  },
  flow_status: {
    description: "Show a project's bound flow and the status of its bound order.", parameters: { type: "object", properties: { project_path: { type: "string" } }, required: ["project_path"], additionalProperties: false },
    execute(input, ctx) { return jsonResult(statusSummary(store(ctx), input.project_path)); },
  },
};

export function getDefinition(name) { const definition = definitions[name]; if (!definition) throw new Error(`Unknown Flow Engine tool: ${name}.`); return definition; }
export async function executeTool(name, input, ctx) { return getDefinition(name).execute(input || {}, ctx); }
