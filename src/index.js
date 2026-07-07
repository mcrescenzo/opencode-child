import { tool } from "@opencode-ai/plugin";
import { createOpenCodeChildPlugin } from "./index-core.js";

// Bind the real opencode `tool` helper (identity fn; `tool.schema` is zod) to
// the pure factory defined in ./index-core.js. All plugin logic lives in the
// core module so it stays testable without opencode infrastructure.
export default createOpenCodeChildPlugin(tool);
