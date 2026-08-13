import { getDefinition } from "./flow.js";
const tool = getDefinition("flow_sign");
export const name = "flow_sign";
export const description = tool.description;
export const parameters = tool.parameters;
export const execute = tool.execute;
