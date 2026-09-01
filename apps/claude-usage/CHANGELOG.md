# Claude Usage

## 0.1.0

First release.

- Usage screen: one card per Claude Code account, with a bar and a ticking reset countdown per limit, extra-usage credits when enabled, and a stale badge when a token has expired.
- Machine screen: tokens per day, the input/cache/output split, top projects and the model mix, read incrementally from the transcript tree.
- Sessions screen: what is running on this machine right now, with its title, model, branch and context size.
- Ambient screen: clock, date, and one line saying whether anything needs a person.
- Optional and off by default: answer Claude Code permission prompts from the dial. Enabling it installs a `PreToolUse` hook that only holds a tool call while someone is at the device; running out of time hands the question back to the terminal.
