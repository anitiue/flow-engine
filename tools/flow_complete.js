import { getDefinition } from "./flow.js";
const tool = getDefinition("flow_complete");
export const name = "flow_complete";
export const description = tool.description;
export const parameters = tool.parameters;
export const execute = tool.execute;
