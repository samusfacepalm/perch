#!/usr/bin/env node
// The bundled build starts several times faster; fall back to the plain tsc output if it's missing.
import fs from "node:fs";
const bundle = new URL("../dist/perch.mjs", import.meta.url);
await import(fs.existsSync(bundle) ? bundle.href : "../dist/cli.js");
