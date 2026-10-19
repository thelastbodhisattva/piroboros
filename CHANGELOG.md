# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

New features and bug fixes are planned for 2026-10-22.

### Changed

- The README is a short overview with diagrams of a turn, the Conclave and where data goes. The full reference moved to `docs/`, which ships in the package.

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
