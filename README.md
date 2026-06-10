# opencode-cmux-notifier

OpenCode plugin that reports agent status to `cmux` and sends completion or input-needed notifications.

## Requirements

- Node.js and npm
- OpenCode with plugin support
- `cmux` CLI available on `PATH`
- A running `cmux` session or a valid `CMUX_SOCKET_PATH`

## Install

```sh
npm install
```

## Configure OpenCode

Reference `plugins/cmux-status.js` from the plugin list in your OpenCode configuration.

Example:

```json
{
  "plugin": ["/absolute/path/to/opencode-cmux-notifier/plugins/cmux-status.js"]
}
```

The plugin only calls `cmux` when it detects one of these conditions:

- `CMUX_WORKSPACE_ID` is set
- `CMUX_SURFACE_ID` is set
- `CMUX_SOCKET_PATH` exists, `/tmp/cmux.sock` exists, or `~/.local/state/cmux/cmux.sock` exists

When `CMUX_WORKSPACE_ID` is set, the plugin passes it to `cmux` as `--workspace`.

## Status Capabilities

- `working`: LLM or agent work is in progress. Triggered by `chat.params`, `chat.message`, `tool.execute.before`, and busy session status events.
- `waitingForInput`: OpenCode is waiting for user input or permission, shown as `Needs Input`. Triggered by permission ask/update events.
- `retrying`: The session is retrying a failed operation.
- `idle`: The active session is idle or complete.
- `error`: The active session errored.

## Notifications

The plugin sends `cmux notify` events when:

- OpenCode is waiting for permission or user input
- An agent tool finishes
- A session becomes idle
- A session errors

## Verify

Run the local verification script:

```sh
npm run verify
```

The script confirms the plugin exports the expected capabilities, exposes OpenCode-loadable hooks, and emits the expected `cmux` commands through a temporary mock CLI.

## Project Layout

- `plugins/cmux-status.js`: OpenCode plugin implementation.
- `scripts/verify-capabilities.js`: Local verification script.
- `package.json`: npm metadata and scripts.

## License

MIT. See `LICENSE`.
