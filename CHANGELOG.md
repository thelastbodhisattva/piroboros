# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [0.3.1] - 2026-10-27

### Security

- A native bubblewrap sandbox no longer takes its read-only object folders from the Workspace's `.git/objects/info/alternates`, a file Vesperia can write. The list comes from your live repository when the Workspace opens or reopens, is stored with the Workspace, and only a folder named `objects` is shared. A path that is, or holds, a hidden folder is never bound back. A Workspace opened by 0.3.0 shares no object folders until it is reopened.

### Fixed

- The start-up recovery no longer repeats the cleanup of every merge that finished earlier. A finished merge is marked once its cleanup is done, so a start no longer runs it again or prints a line for each. The merge record keeps its state, so `/conclave undo` is unchanged. An existing store gets one new column and cleans each old merge one more time.
- The 10 second limit on the sandbox's helper programs ignored the time a caller asked for, so `docker run` could be cut off at 10 seconds instead of 30.
- A merge where a folder Vesperia needs is a file in your project reported a `preflight` hold, not a `type` conflict.
- `docs/conclave.md` now names bubblewrap in WSL 2 among the confined setups.

## [0.3.0] - 2026-10-26

### Added

- Workspaces for Vesperia. `/conclave approve` copies the project's git-visible files into a private Workspace and she works there; when her run ends `done`, her changes are merged back three-way, with a snapshot of every live path taken first, rollback on a failed step and recovery after a crash. Conflicts, holds and a live file over 64 MiB leave the Workspace in place. `node_modules` starts empty in the Workspace, and git-ignored and secret-named files are not copied. New commands `/conclave merge`, `/conclave discard` and `/conclave retry`; `/conclave undo` and `/conclave status` cover Workspace runs. New settings `workspace.enabled` and `workspace.nested`.
- Shell confinement with bubblewrap on Linux. When a Workspace opens, a self-test decides whether Vesperia's commands run inside `bwrap`: the system is read-only, your home folder and `PIROBOROS_HOME` are hidden, writes outside the Workspace fail or vanish when the command ends, and the network is on or off by `workspace.network`. If no backend is usable (bubblewrap missing or failing its self-test, or macOS without Docker), the commands run unconfined and the start notice, the brief and `/conclave status` say so. New settings `workspace.confine` (`auto` or `none`) and `workspace.network`, both security settings. A confined command can be at most 131,071 bytes and cannot hold a NUL byte.
- Shell confinement on Windows with bubblewrap in WSL 2. Commands run as the distribution's default user through `wsl.exe` with an argument list and an environment built inside WSL; your Windows drives are hidden except the Workspace and the live `.git/objects`, Windows programs and the WSL interop socket are blocked, and `node_modules` lives on the distribution's own filesystem. New setting `workspace.wsl.distro`. See Tools.
- A seccomp filter in every bubblewrap sandbox: AF_VSOCK sockets (through which the WSL host answers) and `io_uring` are refused, and 32-bit system calls are killed. A failed filter or self-test gives no sandbox and the warning.
- Shell confinement with Docker, natively or in WSL 2 on Windows. New setting `workspace.docker.image` (a security setting) and the value `docker` for `workspace.confine`. One container per Workspace, with only the Workspace and the live git objects mounted, all capabilities dropped and the Engine's seccomp profile kept; a self-test checks that AF_VSOCK sockets and `io_uring` are refused. A container that disappears during a run ends the run held with the reason `confinement backend unavailable`. piroboros never pulls an image. See Tools.
- Conflict resolution for Workspaces. A text conflict leaves marker blocks in the Workspace file; removing them (or making the file equal the live one) resolves it, and `/conclave merge` can force her stored version. Approving the same plan again reopens the Workspace and refreshes the files you changed live. A `.lww` file in the project root makes the later-modified side win for the paths it matches.
- Learning loop and `/learn`. With `learning.model` set, a background pass every few user turns proposes skills and memories from the chat. Skills are staged and written only after `/learn accept <name>` shows the text or diff; memories are quarantined until `/akashic accept`. `/learn undo`, `reject`, `now`, `retry` and `skip`. New settings `learning.model`, `learning.thinking`, `learning.everyTurns` and `learning.allowThirdParty`; the model and the consent flag are security settings.
- `guard.allow`: project folders opened inside a protected location, at or inside the pi extensions folder or strictly inside a `guard.deny` root. Credential file names stay refused inside them. A security setting, confirmed on change.
- A bash path tripwire: commands that name a protected location or a credential file, or climb out of a `guard.allow` folder with `..`, are refused. It catches accidents and is not confinement.
- `PI_CODING_AGENT_DIR` outside `~/.pi` is protected like `~/.pi`.

### Fixed

- The WSL `bash.exe` alias in `WindowsApps` is never chosen as the shell.

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
