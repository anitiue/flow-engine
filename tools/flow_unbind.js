import { getDefinition } from "./flow.js";
const tool = getDefinition("flow_unbind");
export const name = "flow_unbind";
export const description = tool.description;
export const parameters = tool.parameters;
export const execute = tool.execute;
