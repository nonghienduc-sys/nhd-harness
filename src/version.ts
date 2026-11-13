import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

/** The package manifest remains the production version authority; staging may override it explicitly. */
export const VERSION = process.env.WORKSTATION_MCP_VERSION?.trim() || packageJson.version;
