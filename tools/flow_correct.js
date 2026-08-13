import { getDefinition } from "./flow.js";
const tool = getDefinition("flow_correct");
export const name = "flow_correct";
export const description = tool.description;
export const parameters = tool.parameters;
export const execute = tool.execute;
