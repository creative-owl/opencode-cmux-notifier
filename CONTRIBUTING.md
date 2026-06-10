# Contributing

## Setup

```sh
npm install
```

## Development

- Keep plugin behavior in `plugins/cmux-status.js`.
- Update `STATUS_CAPABILITIES` when adding or changing status behavior.
- Keep `README.md` in sync with supported hooks, environment variables, and notification behavior.

## Verification

Run the verification script before committing changes:

```sh
npm run verify
```

## Commits

Use Conventional Commits, for example:

```text
fix: handle missing cmux socket
```
