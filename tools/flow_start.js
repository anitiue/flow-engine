import { getDefinition } from "./flow.js";
const tool = getDefinition("flow_start");
export const name = "flow_start";
export const description = tool.description;
export const parameters = tool.parameters;
export const execute = tool.execute;
