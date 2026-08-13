import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const ISO_DAY_MS = 24 * 60 * 60 * 1000;

export function assertId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be 1-80 characters of letters, numbers, _ or -, and cannot start with _ or -.`);
  }
  return value;
}

export function assertText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required.`);
  return value.trim();
}

export function getDataDir(toolCtx) {
  if (toolCtx?.dataDir) return path.resolve(toolCtx.dataDir);
  const hanaHome = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
  return path.resolve(hanaHome, "plugin-data", "flow-engine");
}

export function pathsFor(dataDir) {
  const root = path.resolve(dataDir);
  return {
    root,
    flows: path.join(root, "flows"),
    orders: path.join(root, "orders"),
    archive: path.join(root, "archive"),
    bindings: path.join(root, "bindings.json"),
  };
}

export function ensureStore(dataDir) {
  const paths = pathsFor(dataDir);
  for (const directory of [paths.root, paths.flows, paths.orders, paths.archive]) fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(paths.bindings)) writeJsonAtomic(paths.bindings, {});
  cleanupArchive(paths.archive);
  return paths;
}

function cleanupArchive(archiveDir) {
  const cutoff = Date.now() - 180 * ISO_DAY_MS;
  for (const entry of fs.readdirSync(archiveDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(archiveDir, entry.name, "manifest.json");
    try {
      const manifest = readJson(manifestPath);
      const archivedAt = Date.parse(manifest.archived_at || "");
      if (Number.isFinite(archivedAt) && archivedAt < cutoff) fs.rmSync(path.join(archiveDir, entry.name), { recursive: true, force: true });
    } catch {
      // An unreadable archive is preserved; cleanup must never delete uncertain data.
    }
  }
}

export function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function agentId(toolCtx, input) {
  const value = input?.agent_id || toolCtx?.agentId || toolCtx?.agent?.id;
  if (!value) throw new Error("agent_id is required because signatures and events require an accountable agent identity.");
  return assertId(String(value), "agent_id");
}

export function appendEvent(orderDir, type, payload, agent) {
  const event = { timestamp: new Date().toISOString(), agent, type, ...payload };
  fs.appendFileSync(path.join(orderDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export function readEvents(orderDir) {
  const file = path.join(orderDir, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export function orderDir(paths, orderId) {
  assertId(orderId, "order_id");
  return path.join(paths.orders, orderId);
}

export function loadOrder(paths, orderId) {
  const directory = orderDir(paths, orderId);
  if (!fs.existsSync(directory)) throw new Error(`Order not found: ${orderId}.`);
  const manifest = readJson(path.join(directory, "manifest.json"));
  const definition = readDefinitionFile(path.join(directory, "definition.yaml"));
  return { directory, manifest, definition };
}

export function orderStatus(paths, orderId) {
  const order = loadOrder(paths, orderId);
  return deriveState(order.manifest, order.definition, readEvents(order.directory)).status;
}

function ordersForProject(paths, projectPath, status) {
  const project = normalizedProject(projectPath);
  const orders = [];
  for (const entry of fs.readdirSync(paths.orders, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(paths.orders, entry.name);
    try {
      const manifest = readJson(path.join(directory, "manifest.json"));
      if (typeof manifest.project_path !== "string" || normalizedProject(manifest.project_path) !== project) continue;
      const definition = readDefinitionFile(path.join(directory, "definition.yaml"));
      const state = deriveState(manifest, definition, readEvents(directory));
      if (state.status === status) orders.push({ directory, manifest, state });
    } catch {
      // A malformed order cannot be safely treated as active or paused.
    }
  }
  return orders;
}

// Scan active orders as well as bindings so an overwritten or stale binding cannot
// create a second running order for the same project.
export function findRunningOrderForProject(paths, projectPath) {
  const order = ordersForProject(paths, projectPath, "running")[0];
  return order ? order.manifest.order_id || path.basename(order.directory) : null;
}

export function findPausedOrdersForProject(paths, projectPath) {
  return ordersForProject(paths, projectPath, "paused").map(({ manifest, state }) => ({
    order_id: manifest.order_id,
    title: manifest.title,
    current_step: state.currentStepId,
    paused_at: manifest.paused_at || null,
    reason: manifest.pause_reason || null,
  }));
}

export function clearOrderBindings(paths, orderId) {
  const bindings = loadBindings(paths);
  let bindingsUpdated = false;
  for (const [project, binding] of Object.entries(bindings)) {
    if (binding?.order_id === orderId) {
      bindings[project] = { ...binding, order_id: null, updated_at: new Date().toISOString() };
      bindingsUpdated = true;
    }
  }
  if (bindingsUpdated) writeJsonAtomic(paths.bindings, bindings);
}

export function saveOrderManifest(directory, manifest) {
  writeJsonAtomic(path.join(directory, "manifest.json"), manifest);
}

// JSON is a safe, standard YAML subset. Definitions created by this plugin use it,
// avoiding custom tags, functions, aliases, and arbitrary object deserialization.
export function readDefinitionFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid flow definition ${path.basename(filePath)}. Flow Engine accepts JSON-format YAML only for safe parsing.`);
  }
}

export function validateDefinition(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new Error("Flow definition must be an object.");
  assertId(definition.flow_id, "flow_id");
  assertText(definition.version, "version");
  assertText(definition.name, "name");
  assertText(definition.purpose, "purpose");
  if (!definition.report || typeof definition.report !== "object" || Array.isArray(definition.report)) throw new Error("report is required.");
  assertText(definition.report.to, "report.to");
  assertText(definition.report.content, "report.content");
  assertText(definition.report.format, "report.format");
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) throw new Error("steps must contain at least one step.");
  let finalCount = 0;
  const stepIds = new Set();
  for (const step of definition.steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error("Each step must be an object.");
    assertId(step.id, "step.id");
    if (stepIds.has(step.id)) throw new Error(`Duplicate step id: ${step.id}.`);
    stepIds.add(step.id);
    assertText(step.name, "step.name");
    assertText(step.agent, "step.agent");
    assertText(step.deliverable, "step.deliverable");
    if (!Array.isArray(step.acceptance) || step.acceptance.length === 0 || step.acceptance.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`step ${step.id} must have at least one non-empty acceptance item.`);
    }
    if (step.is_final === true) finalCount += 1;
  }
  if (finalCount > 1) throw new Error("At most one step may set is_final to true.");
  return definition;
}

export function flowFile(paths, flowId) {
  assertId(flowId, "flow_id");
  return path.join(paths.flows, `${flowId}.yaml`);
}

export function loadFlow(paths, flowId) {
  const file = flowFile(paths, flowId);
  if (!fs.existsSync(file)) throw new Error(`Flow not found: ${flowId}.`);
  return validateDefinition(readDefinitionFile(file));
}

export function deriveState(manifest, definition, events) {
  const steps = definition.steps.map((step) => ({ ...step, signed: null }));
  let status = manifest.status || "running";
  let currentStepId = manifest.current_step_id || steps[0]?.id || null;
  for (const event of events) {
    if (event.type === "signed") {
      const step = steps.find((item) => item.id === event.step_id);
      if (step) step.signed = event;
    } else if (event.type === "paused") status = "paused";
    else if (event.type === "resumed") status = "running";
    else if (event.type === "completed") status = "completed";
    else if (event.type === "closed") status = "closed";
    else if (event.type === "archived") status = "archived";
  }
  const firstUnsigned = steps.find((step) => !step.signed);
  if (status === "running" && !currentStepId && firstUnsigned) currentStepId = firstUnsigned.id;
  return { status, currentStepId, steps, currentIndex: steps.findIndex((step) => step.id === currentStepId) };
}

export function checkGate({ definition, manifest, events, agent }) {
  const state = deriveState(manifest, definition, events);
  if (state.status !== "running") return { code: 12, reason: `Order is ${state.status}.`, state };
  const step = state.steps.find((item) => item.id === state.currentStepId);
  if (!step) return { code: 13, reason: "Order has no current step.", state };
  if (step.signed) return { code: 14, reason: step.is_final ? "Final step is already signed; complete the order instead." : `Current step ${step.id} is already signed.`, step, state };
  if (String(step.agent) !== String(agent)) return { code: 11, reason: `Current step ${step.id} belongs to ${step.agent}.`, step, state };
  const stepIndex = state.steps.findIndex((item) => item.id === step.id);
  const missing = state.steps.slice(0, stepIndex).find((item) => !item.signed);
  if (missing) return { code: 10, reason: `Prerequisite ${missing.id} (${missing.name}) is not signed.`, step, state, missing };
  return { code: 0, reason: "Gate passed.", step, state };
}

export function loadBindings(paths) {
  const bindings = readJson(paths.bindings);
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) throw new Error("bindings.json is invalid.");
  return bindings;
}

export function normalizedProject(projectPath) {
  const text = assertText(projectPath, "project_path");
  if (text.includes("\0")) throw new Error("project_path contains a null byte.");
  return path.resolve(text).replace(/[\\/]+$/, "").toLowerCase();
}

export function getBoundProject(paths, candidate) {
  const bindings = loadBindings(paths);
  const project = normalizedProject(candidate);
  return { project, binding: bindings[project] || null, bindings };
}

export function statusSummary(paths, projectPath) {
  const { project, binding } = getBoundProject(paths, projectPath);
  const paused_orders = findPausedOrdersForProject(paths, project);
  if (!binding) return { project_path: project, binding: null, order: null, paused_orders };
  if (!binding.order_id) return { project_path: project, binding, order: null, paused_orders };
  try {
    const order = loadOrder(paths, binding.order_id);
    const state = deriveState(order.manifest, order.definition, readEvents(order.directory));
    return { project_path: project, binding, order: { order_id: binding.order_id, status: state.status, current_step_id: state.currentStepId }, paused_orders };
  } catch (error) {
    return { project_path: project, binding, order: { order_id: binding.order_id, error: error.message }, paused_orders };
  }
}

export function jsonResult(value) {
  return JSON.stringify(value, null, 2);
}
