# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-24

### Added

- `/telemetry` and the `telemetry` setting. Model request and task timings are recorded to `telemetry.sqlite` in `PIROBOROS_HOME`, on by default, local only, with no message text and no error text. `"telemetry": false` stops it at the next start.
- The first start copies the chat database to `chat.schema1.sqlite` before the schema 2 upgrade and checks the copy.

### Changed

- Built on pi-durable, chord and pi-ai 1.4.0. The chat database moves to schema 2 on the first start, and 0.1.0 cannot open it after that. The start first copies it to `chat.schema1.sqlite`, so you can go back by restoring that copy.
- piroboros sends no provider attribution headers. Requests still carry the pi-ai User-Agent.
- Compactor retry waits survive a restart: closing piroboros during a wait no longer reruns the request.
- Status line errors name the failing task or extension.
- A task that was cut off on several starts in a row is paused. piroboros says so at every start, and Esc or `/conclave cancel` clears it.
- The README is a short overview with diagrams of a turn, the Conclave and where data goes. The full reference moved to `docs/`, which ships in the package.
- The turn state, plan, Conclave and node documents now store a full copy after every 64 changes, so a long chat no longer replays its whole change history each time one of them is read.
- `--backup` writes to `<file>.tmp`, checks the copy with SQLite `quick_check` and only then renames it, so a failed backup never leaves a file under the final name.

### Fixed

- Windows shell lookup with an unusual `SystemRoot`.
- Whitespace-only tool output was rejected by the OpenAI and Google providers.
- Gateway `upstream_error` replies were not retried.

## [0.1.0] - 2026-10-17

First release.

### Added

- A terminal chat built around one long-lived conversation. Each turn sends a fresh request made from a size-limited view of the chat, and a background compactor keeps that view small.
- The Conclave, a panel of review agents that runs one member at a time in its own child conversation, started with `/conclave` and shown in a side pane.
- Memory tools, the `/akashic` commands and an optional memory vault mirrored to a private GitHub repository.
- Web access for the Vaelia seat (`web_fetch` and `web_search`), off by default.
- `SKILL.md` skills for the main chat.
- A thinking-steps panel, a themed and framed layout, scrolling, and a command list with settings and login screens.
- Guarded file and shell tools with a tripwire guard, undo copies, and file search through fff or ripgrep.
- A guided setup wizard, `--print` and `--backup`.
- An npm package that installs and runs on Node 26.5 or newer. A checkout runs the TypeScript sources; the installed package runs compiled JavaScript.
