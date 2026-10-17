#!/usr/bin/env node
// Launcher: checks the Node version, then loads the program. A checkout (src/main.ts present and no node_modules
// segment in this file's real path) runs the TypeScript sources through Node type stripping; an install runs the
// compiled dist/, because Node does not strip types under node_modules. prepack builds dist/.
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 26 || (major === 26 && minor < 5)) {
	console.error(`piroboros: Node 26.5.0 or newer is required (found ${process.versions.node}).`);
	process.exit(2);
}
// chalk reads FORCE_COLOR but not NO_COLOR, so NO_COLOR is turned into FORCE_COLOR=0 before anything loads it.
if (process.env.NO_COLOR && process.env.FORCE_COLOR === undefined) process.env.FORCE_COLOR = "0";
const here = realpathSync(fileURLToPath(import.meta.url));
const fromSource = existsSync(new URL("../src/main.ts", import.meta.url)) && !/[\\/]node_modules[\\/]/.test(here);
const { main } = await import(fromSource ? "../src/main.ts" : "../dist/main.js");
process.exitCode = await main(process.argv.slice(2));
