import { getDefinition } from "./flow.js";
const tool = getDefinition("flow_pause");
export const name = "flow_pause";
export const description = tool.description;
export const parameters = tool.parameters;
export const execute = tool.execute;
