import { getDefinition } from "./flow.js";
const tool = getDefinition("flow_new");
export const name = "flow_new";
export const description = tool.description;
export const parameters = tool.parameters;
export const execute = tool.execute;
