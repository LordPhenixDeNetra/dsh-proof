# Changelog

## [Unreleased]

### Added

- Tag-triggered GitHub release workflow: tests, tag/version check, pack, release, and `.tgz` asset.

## [0.1.1] — 2026-10-23

### Fixed

- Fall back to `npm` when the lockfile manager (`pnpm`, `yarn`, `bun`) is not on `PATH`, instead of failing every check.
- Skip verification for sessions with no working directory rather than running checks in the DSH installation directory.
- Treat a timed-out command as a failure even if its exit code is `0`.
- Drop per-session state when a session is disposed.
- Strip ANSI escape codes from captured output and normalize line endings.
- Kill the whole POSIX process group on timeout or cancellation, not just the shell.

### Changed

- Removed the fixed five-minute `verify` tool deadline; per-check `timeoutMs` is now the only limit.
- Output-schema fields are required, so the tool result is checked strictly by the registry.
- Stricter TypeScript settings (`noUnusedLocals`, `noUnusedParameters`, declaration maps).
- Documentation now shows a top-level profile override instead of a duplicate `insert` row.

## [0.1.0] — 2026-10-23

### Added

- Initial host-only verification gate: `verify` tool, prompt section, `agent/turn-stopping` enforcement, bounded corrective reruns.
- Automatic detection of `typecheck`, `lint`, `test`, and `check` scripts.
- Session-scoped edit tracking and configurable shell-mutation heuristic.
- Unit tests for detection, execution, steering, rerun limits, and plugin wiring.
