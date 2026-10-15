#!/usr/bin/env node
/*
 * Grungus — syntax check for every JS file in the repo.
 * There is no build step and no TypeScript, so `node --check` across the
 * tree is our lint gate.
 *
 * Run: npm run check
 */
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TARGETS = ["src", "tests", "scripts", "examples"];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = [];
for (const target of TARGETS) {
  const dir = path.join(ROOT, target);
  if (!fs.existsSync(dir)) continue;
  walk(dir, files);
}

let failures = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    failures++;
    const rel = path.relative(ROOT, file);
    console.error("FAIL " + rel);
    console.error(String((err.stderr || err.message || "").trim()));
  }
}

console.log("Checked " + files.length + " JS files, " + failures + " failure(s).");
process.exit(failures ? 1 : 0);
