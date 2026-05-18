#!/usr/bin/env node
import { execFileSync } from "node:child_process";

// Run a command and capture stdout for checks and lookups.
function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

// Run a command attached to the terminal so git and gh output stays visible.
function runStreaming(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

// Minimal flag parsing, enough for this script's small CLI surface.
function hasFlag(flag) {
  return process.argv.includes(flag);
}

function getFlagValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

// Derive the release tag from package.json so npm and GitHub stay in sync.
const version = run("node", ["-p", "require('./package.json').version"]);
const tag = `v${version}`;
const notes = getFlagValue("--notes") ?? `Release ${tag}`;
const recreate = hasFlag("--recreate");
const latest = !hasFlag("--no-latest");
const dryRun = hasFlag("--dry-run");

// Guard rails: only release from a clean, up to date main branch.
const branch = run("git", ["branch", "--show-current"]);
if (branch !== "main")
  fail(`release must run from main, current branch is ${branch}`);

run("git", ["fetch", "origin", "main"]);

const status = run("git", ["status", "--porcelain"]);
if (status) fail("working tree is not clean");

const head = run("git", ["rev-parse", "HEAD"]);
const originMain = run("git", ["rev-parse", "origin/main"]);
if (head !== originMain) {
  fail("HEAD is not at origin/main, pull or push first");
}

// Check whether we are creating a fresh release or replacing an existing one.
let tagExists = true;
try {
  run("git", ["rev-parse", "--verify", tag]);
} catch {
  tagExists = false;
}

let releaseExists = true;
try {
  run("gh", ["release", "view", tag, "--json", "tagName"]);
} catch {
  releaseExists = false;
}

if ((tagExists || releaseExists) && !recreate) {
  fail(
    `${tag} already exists. Re-run with --recreate to delete and recreate it.`,
  );
}

// Dry run prints the resolved inputs without changing GitHub or git state.
if (dryRun) {
  console.log(
    JSON.stringify({ version, tag, notes, recreate, latest, head }, null, 2),
  );
  process.exit(0);
}

// In recreate mode, remove the old release before reusing the same tag name.
if (releaseExists) {
  console.log(`Deleting existing GitHub release ${tag}`);
  runStreaming("gh", ["release", "delete", tag, "--yes"]);
}

if (tagExists) {
  console.log(`Deleting existing git tag ${tag}`);
  runStreaming("git", ["push", "origin", `:refs/tags/${tag}`]);
  runStreaming("git", ["tag", "-d", tag]);
}

// Tag first, then create the GitHub release. The publish workflow triggers on
// release publication, not on tag push.
console.log(`Creating tag ${tag} at ${head}`);
runStreaming("git", ["tag", "-a", tag, "-m", tag]);
runStreaming("git", ["push", "origin", tag]);

console.log(`Creating GitHub release ${tag}`);
const createArgs = ["release", "create", tag, "--title", tag, "--notes", notes];
if (latest) createArgs.push("--latest");
runStreaming("gh", createArgs);

console.log(`Triggered publish workflow for ${tag}`);
console.log("Watch it with:");
console.log("  gh run list --workflow publish.yml --limit 5");
