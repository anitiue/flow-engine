import { getDefinition } from "./flow.js";
const tool = getDefinition("flow_close");
export const name = "flow_close";
export const description = tool.description;
export const parameters = tool.parameters;
export const execute = tool.execute;
