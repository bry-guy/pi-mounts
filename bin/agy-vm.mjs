#!/usr/bin/env node
// AGY_BIN for @estebanforge/pi-antigravity-bridge: agy in the role's VM (see bin/vm-exec.mjs).
import { run } from "./vm-exec.mjs";

run("agy", process.argv.slice(2));
