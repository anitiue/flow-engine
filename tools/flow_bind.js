import { getDefinition } from "./flow.js";
const tool = getDefinition("flow_bind");
export const name = "flow_bind";
export const description = tool.description;
export const parameters = tool.parameters;
export const execute = tool.execute;
