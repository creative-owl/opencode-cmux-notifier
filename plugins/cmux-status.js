import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const STATUS_KEY = "opencode";
const TITLE = "OpenCode";
const DEFAULT_SOCKET = "/tmp/cmux.sock";
const COMMAND_TIMEOUT = 3000;
const AGENT_TOOL_NAMES = new Set(["Task", "task", "subtask", "agent"]);

const STATUS = {
  running: { label: "Running", color: "#0a84ff", priority: 90 },
  waiting: { label: "Waiting", color: "#ff9500", priority: 100 },
  retrying: { label: "Retrying", color: "#ffcc00", priority: 95 },
  idle: { label: "Idle", color: "#34c759", priority: 50 },
  error: { label: "Error", color: "#ff3b30", priority: 100 },
};

export const STATUS_CAPABILITIES = Object.freeze({
  working: {
    status: STATUS.running,
    description: "LLM or agent work is in progress",
    triggers: ["chat.params", "chat.message", "tool.execute.before", "event:session.status:busy"],
  },
  waitingForInput: {
    status: STATUS.waiting,
    description: "OpenCode is waiting for user input or permission",
    triggers: ["permission.ask:ask", "event:permission.asked", "event:permission.updated"],
  },
  retrying: {
    status: STATUS.retrying,
    description: "The session is retrying a failed operation",
    triggers: ["event:session.status:retry"],
  },
  idle: {
    status: STATUS.idle,
    description: "The active session is idle or complete",
    triggers: ["event:session.status:idle", "event:session.idle"],
  },
  error: {
    status: STATUS.error,
    description: "The active session errored",
    triggers: ["event:session.error"],
  },
});

export const SUPPORTED_HOOKS = Object.freeze([
  "chat.message",
  "chat.params",
  "tool.execute.before",
  "tool.execute.after",
  "permission.ask",
  "event",
]);

function hasCmuxContext() {
  if (process.env.CMUX_WORKSPACE_ID || process.env.CMUX_SURFACE_ID) {
    return true;
  }

  const socketPath = process.env.CMUX_SOCKET_PATH || DEFAULT_SOCKET;
  return existsSync(socketPath);
}

function workspaceArgs() {
  return process.env.CMUX_WORKSPACE_ID ? ["--workspace", process.env.CMUX_WORKSPACE_ID] : [];
}

function runCmux(args) {
  if (!hasCmuxContext()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const child = spawn("cmux", [...args, ...workspaceArgs()], {
      stdio: "ignore",
      env: process.env,
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, COMMAND_TIMEOUT);

    child.once("error", () => {
      clearTimeout(timer);
      resolve();
    });

    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function errorMessage(error) {
  if (error?.data?.message) {
    return error.data.message;
  }

  if (error?.message) {
    return error.message;
  }

  if (error?.name) {
    return error.name;
  }

  return "An error occurred";
}

export default async function CmuxStatusPlugin() {
  let cmuxQueue = Promise.resolve();
  let activeSessionID;
  let currentStatus;
  const notifiedIdleSessions = new Set();
  const waitingPermissions = new Set();

  function queueCmux(args) {
    cmuxQueue = cmuxQueue.then(() => runCmux(args), () => runCmux(args));
    return cmuxQueue;
  }

  function setStatus(status) {
    const nextStatus = `${status.label}:${status.color}:${status.priority}`;
    if (currentStatus === nextStatus) {
      return Promise.resolve();
    }

    currentStatus = nextStatus;

    return queueCmux([
      "set-status",
      STATUS_KEY,
      status.label,
      "--color",
      status.color,
      "--priority",
      String(status.priority),
    ]);
  }

  function clearStatus() {
    currentStatus = undefined;
    return queueCmux(["clear-status", STATUS_KEY]);
  }

  function notify({ subtitle, body }) {
    const args = ["notify", "--title", TITLE, "--body", body];
    if (subtitle) {
      args.splice(3, 0, "--subtitle", subtitle);
    }

    return queueCmux(args);
  }

  async function markRunning(sessionID) {
    if (sessionID) {
      activeSessionID = sessionID;
      notifiedIdleSessions.delete(sessionID);
    }

    await setStatus(STATUS.running);
  }

  async function markWaiting(permission) {
    if (permission?.id && waitingPermissions.has(permission.id)) {
      return;
    }

    if (permission?.id) {
      waitingPermissions.add(permission.id);
    }

    if (permission?.sessionID) {
      activeSessionID = permission.sessionID;
    }

    await setStatus(STATUS.waiting);
    await notify({
      subtitle: "Waiting",
      body: permission?.title || "Agent needs input",
    });
  }

  return {
    dispose: clearStatus,

    "chat.message": async (input) => {
      await markRunning(input.sessionID);
    },

    "chat.params": async (input) => {
      await markRunning(input.sessionID);
    },

    "tool.execute.before": async (input) => {
      await markRunning(input.sessionID);
    },

    "tool.execute.after": async (input) => {
      if (AGENT_TOOL_NAMES.has(input.tool)) {
        await notify({ body: "Agent finished" });
      }
    },

    "permission.ask": async (input, output) => {
      if (output.status === "ask") {
        await markWaiting(input);
      }
    },

    event: async ({ event }) => {
      switch (event.type) {
        case "session.status": {
          const { sessionID, status } = event.properties;
          activeSessionID = sessionID;

          if (status.type === "busy") {
            await markRunning(sessionID);
            return;
          }

          if (status.type === "retry") {
            notifiedIdleSessions.delete(sessionID);
            await setStatus(STATUS.retrying);
            return;
          }

          await setStatus(STATUS.idle);
          return;
        }

        case "session.idle": {
          const { sessionID } = event.properties;
          activeSessionID = sessionID;
          await setStatus(STATUS.idle);

          if (!notifiedIdleSessions.has(sessionID)) {
            notifiedIdleSessions.add(sessionID);
            await notify({ body: "Session complete" });
          }
          return;
        }

        case "session.error": {
          activeSessionID = event.properties.sessionID || activeSessionID;
          await setStatus(STATUS.error);
          await notify({
            subtitle: "Error",
            body: errorMessage(event.properties.error),
          });
          return;
        }

        case "permission.updated":
        case "permission.asked":
          await markWaiting(event.properties);
          return;

        case "permission.replied":
          waitingPermissions.delete(event.properties.permissionID);
          await markRunning(event.properties.sessionID);
          return;

        case "session.deleted":
          if (event.properties.info.id === activeSessionID) {
            activeSessionID = undefined;
            await clearStatus();
          }
          return;

        case "server.instance.disposed":
          await clearStatus();
          return;
      }
    },
  };
}
