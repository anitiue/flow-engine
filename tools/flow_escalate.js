import { getDefinition } from "./flow.js";
const tool = getDefinition("flow_escalate");
export const name = "flow_escalate";
export const description = tool.description;
export const parameters = tool.parameters;
export const execute = tool.execute;
