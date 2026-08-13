import { getDefinition } from "./flow.js";
const tool = getDefinition("flow_resume");
export const name = "flow_resume";
export const description = tool.description;
export const parameters = tool.parameters;
export const execute = tool.execute;
