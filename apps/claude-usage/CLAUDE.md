# Claude Usage

Two halves in one bundle. `extension/` is a Deno process on the desktop that owns every host read; `src/` renders on the device and holds no host knowledge. They talk over the forward surface, typed by `shared/protocol.ts`, which both sides import.

The device never holds a credential and never makes a network call of its own. Every number arrives over `forward`.

## Where the numbers come from

`GET https://api.anthropic.com/api/oauth/usage`, bearer the account's OAuth access token, `anthropic-beta: oauth-2025-04-20`. Render `limits[]`, not the codenamed sibling keys: the codenames are unstable and several are unreleased. An unrecognized `kind` still gets a labeled bar, or a new limit type disappears from the screen silently. Severity picks the colour, not the raw percentage.

An account is a Claude Code config directory. `~/.claude` is the default; discovery keeps every `~/.claude*` directory holding `.claude.json` or `projects/`. On macOS the credential is a keychain item, `Claude Code-credentials` for the default directory and `Claude Code-credentials-<first 8 hex of sha256(path)>` for any other, with the path hashed unresolved and without a trailing slash. A `.credentials.json` can also sit beside the keychain item there and holds a revoked token, so the keychain wins. Elsewhere the file is the store.

The account label comes from `oauthAccount` in `.claude.json`, which lives beside the default directory and inside every other one. `claude auth status --json` returns the same fields, but two of those racing over one config file is how an account ends up unlabeled, and reading the file drops the `run:claude` permission.

**Default is read only.** A token past `expiresAt` keeps the last good reading with a stale badge. The per-account refresh toggle is off by default: rotation invalidates the refresh token an idle `claude` process still holds in memory. It only fires within 60 seconds of expiry, takes a lock and re-reads the store after acquiring it, and writes both halves of the pair or neither.

## Transcripts

`projects/<slug>/<session>.jsonl`, plus `projects/<slug>/<session>/subagents/*.jsonl`. Subagent turns are real spend and must be counted, but they are not sessions and set no session fields.

The tree runs to gigabytes, so the scanner tails by byte offset with the offsets in `ctx.kv`, and matches each line as bytes before deciding whether to decode it. Tool results and attachments run to megabytes and carry nothing worth reading, so they never become a javascript string. Bump `SCHEMA` in `transcripts.ts` whenever a turn's contribution to the rollup changes: the rollup is a monotonic accumulator and will otherwise keep stale arithmetic forever.

`usage` on an assistant record sums every iteration of a multi-step turn, so context fill is the last iteration only. Nothing on disk carries the model's context window; `GET /v1/models/{id}` returns it as `max_input_tokens` under the same OAuth token, and it differs by model, so it is looked up per model and cached rather than assumed. The sessions bar falls back to comparing sessions to each other only when a lookup fails.

Config directories that symlink the same `projects/` hold the same transcripts. Every candidate resolves through `realpath` and duplicates collapse, so transcript numbers are machine-wide and say so.

## The prompt hook

Off by default. Turning it on writes an `http` `PreToolUse` hook into each listed account's `settings.json`, backing the file up before the first edit, and starts a loopback server the hook posts to.

Three guards decide whether a call is held, and every one of them fails open:

- the permission mode is `default` or `plan`
- someone has touched the device in the last few minutes, which the webapp reports as `present`
- a Car Thing is connected with this app active

Otherwise it answers `{}` instantly and Claude Code proceeds through its own permission flow. Running out of time answers `{}` too. Nothing ever auto-denies. A server that is not listening is a connection refused, which Claude Code treats as a non-blocking error, so the terminal prompt appears exactly as it would have.

## Permissions

`read:~` and `write:~` are what discovery, the transcript tree and the opt-in credential write need; the config directories cannot be enumerated at manifest time, so neither can be narrower. `run:security` is the macOS keychain. `net:127.0.0.1` is the hook server.
