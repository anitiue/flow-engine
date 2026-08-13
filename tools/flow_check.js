import { getDefinition } from "./flow.js";
const tool = getDefinition("flow_check");
export const name = "flow_check";
export const description = tool.description;
export const parameters = tool.parameters;
export const execute = tool.execute;
