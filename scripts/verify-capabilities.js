import plugin, { STATUS_CAPABILITIES, SUPPORTED_HOOKS } from "../plugins/cmux-status.js";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const expectedStatuses = {
  working: "Running",
  waitingForInput: "Waiting",
  retrying: "Retrying",
  idle: "Idle",
  error: "Error",
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const [name, label] of Object.entries(expectedStatuses)) {
  const capability = STATUS_CAPABILITIES[name];

  assert(capability, `Missing status capability: ${name}`);
  assert(capability.status?.label === label, `${name} should map to ${label}`);
  assert(Array.isArray(capability.triggers) && capability.triggers.length > 0, `${name} needs triggers`);
}

assert(
  STATUS_CAPABILITIES.working.triggers.includes("chat.params"),
  "working capability must include LLM chat.params trigger",
);
assert(
  STATUS_CAPABILITIES.waitingForInput.triggers.includes("permission.ask:ask"),
  "waitingForInput capability must include permission.ask trigger",
);

const tmp = await mkdtemp(path.join(tmpdir(), "opencode-cmux-notifier-"));
const logPath = path.join(tmp, "cmux.log");
const cmuxPath = path.join(tmp, "cmux");
const previousEnv = {
  CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID,
  PATH: process.env.PATH,
};

await writeFile(
  cmuxPath,
  `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
);
await chmod(cmuxPath, 0o755);

process.env.CMUX_WORKSPACE_ID = "verify";
process.env.PATH = `${tmp}${path.delimiter}${process.env.PATH || ""}`;

let hooks;

try {
  hooks = await plugin();

  for (const hookName of SUPPORTED_HOOKS) {
    assert(typeof hooks[hookName] === "function", `Missing plugin hook: ${hookName}`);
  }

  assert(typeof hooks.dispose === "function", "Missing plugin dispose hook");

  await hooks["chat.params"]({ sessionID: "session-1" }, {});
  await hooks["permission.ask"](
    { id: "permission-1", sessionID: "session-1", title: "Approve command" },
    { status: "ask" },
  );
  await hooks.event({
    event: { type: "session.status", properties: { sessionID: "session-1", status: { type: "retry" } } },
  });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
  await hooks.event({
    event: { type: "session.error", properties: { sessionID: "session-1", error: { message: "Boom" } } },
  });
  await hooks.dispose();

  const commands = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  for (const label of Object.values(expectedStatuses)) {
    assert(
      commands.some((command) => command[0] === "set-status" && command[1] === "opencode" && command[2] === label),
      `Missing emitted cmux status: ${label}`,
    );
  }

  assert(
    commands.some((command) => command[0] === "clear-status" && command[1] === "opencode"),
    "Missing clear-status command on dispose",
  );
} finally {
  if (previousEnv.CMUX_WORKSPACE_ID === undefined) {
    delete process.env.CMUX_WORKSPACE_ID;
  } else {
    process.env.CMUX_WORKSPACE_ID = previousEnv.CMUX_WORKSPACE_ID;
  }

  if (previousEnv.PATH === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = previousEnv.PATH;
  }

  await rm(tmp, { recursive: true, force: true });
}
