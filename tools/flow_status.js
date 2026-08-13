import { getDefinition } from "./flow.js";
const tool = getDefinition("flow_status");
export const name = "flow_status";
export const description = tool.description;
export const parameters = tool.parameters;
export const execute = tool.execute;
