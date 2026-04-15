# Codex-to-IM Handover

## 1. Project Positioning

- Repository: `git@github.com:jasonxtt/Codex-to-IM-skill.git`
- Local path: `/home/tom/github/Codex-to-IM-skill`
- Purpose: bridge Codex or Claude Code sessions to IM platforms such as Telegram, Discord, Feishu, QQ, and WeChat
- Current public-facing name: `codex-to-im`
- Current Codex skill entry: `codex-to-im`

Important distinction:

- This repository is now self-contained.
- The bridge core is vendored under `vendor/claude-to-im`.
- Public product naming is `codex-to-im`, while the internal package name `claude-to-im` is kept only for compatibility with existing imports and package exports.

## 2. What Was Completed

### Telegram / Codex workflow

The Codex Telegram interaction layer was enhanced to behave much closer to Codex CLI:

- Added permission profiles: `ask`, `full`, `status`
- Added real approval buttons for ask mode
- Added Chinese permission buttons and Chinese status/menu text
- Added `/sessions` session summaries and inline restore buttons
- Added current-directory/all-directory session scope toggle
- Added `/resume` support matching current working directory behavior
- Added `/cwd` chooser mode with recent directories and direct path entry
- Added `/status` improvements for current session visibility
- Hid `/bind` from the exposed Telegram command menu

### Codex runtime permissions

Codex SDK thread options are now configurable through environment and bridge logic:

- `CTI_CODEX_SANDBOX_MODE`
- `CTI_CODEX_APPROVAL_POLICY`
- `CTI_CODEX_NETWORK_ACCESS`
- `CTI_CODEX_ADDITIONAL_DIRECTORIES`

Ask mode approval flow was fixed so Telegram can show approval buttons and only continue after user choice.

### Naming migration

The skill surface was renamed from `claude-to-im` to `codex-to-im` in the forked repository:

- Skill metadata name
- Install script target directory
- Public command examples
- Default data directory
- User-facing docs
- Service labels and runtime log prefix

This rename and self-contained packaging are implemented in the repository.

## 3. Key Commits

- `893abe1` `feat: improve codex telegram session and permission workflow`
- `3c75a24` `docs: rebrand published docs to codex-to-im`
- `261f086` `refactor: rename skill surface from claude-to-im to codex-to-im`

## 4. Current Local State

### Repository state

- Working tree is clean
- `npm install` has been run
- `npm run build` passes
- `npm test` passes
- Last verified result: `185` tests passed

### Codex local install state

At the time this document was written:

- Old Codex-installed skill `~/.codex/skills/claude-to-im` was removed
- No bridge daemon process is currently running
- Old runtime state directory `~/.claude-to-im` still exists and was intentionally preserved

Why `~/.claude-to-im` still exists:

- It contains previous config, logs, and session data
- It was preserved to avoid accidental data loss during rename/migration

## 5. Important Paths

### Active source repo

- `/home/tom/github/Codex-to-IM-skill`

### Old persisted runtime data

- `/home/tom/.claude-to-im`

### New runtime default after rename

- `/home/tom/.codex-to-im`

## 6. Files Most Relevant To The Rename

- `SKILL.md`
- `scripts/install-codex.sh`
- `scripts/daemon.sh`
- `scripts/doctor.sh`
- `scripts/supervisor-macos.sh`
- `scripts/supervisor-windows.ps1`
- `src/config.ts`
- `src/main.ts`
- `config.env.example`

## 7. Remaining Constraints

These are deliberate and currently acceptable:

- Internal imports still reference the package `claude-to-im`
- `package.json` depends on the vendored package at `"file:./vendor/claude-to-im"`

This means:

- `codex-to-im` is the only required GitHub repository
- `claude-to-im` remains only an internal package name inside this repository

## 8. Recommended Redeploy Procedure

Because the old installed skill was already removed, the next deployment should be a clean install from this repo.

Suggested sequence:

1. Confirm no old bridge process is running.
2. Decide whether to migrate old data from `~/.claude-to-im` to `~/.codex-to-im`.
3. Install from `/home/tom/github/Codex-to-IM-skill`.
4. Verify Codex recognizes the skill entry `codex-to-im`.
5. Run `codex-to-im setup`.
6. Start the bridge and verify Telegram command flow.
7. Test `ask` permission mode with a real approval-required action.

## 9. Data Migration Note

If historical sessions/config should be retained after reinstall, the expected migration direction is:

- from `~/.claude-to-im`
- to `~/.codex-to-im`

At minimum, these files/directories matter:

- `config.env`
- `data/`
- `logs/` if historical logs are needed

Migration was not performed automatically in this phase.

## 10. Verification Checklist For Next Operator

- `codex-to-im setup` triggers the skill
- `codex-to-im start` starts the daemon
- Telegram bot receives and responds
- `/permission ask` shows approval buttons
- `/sessions` shows summaries and restore buttons
- `/cwd` shows recent directories and direct path input support
- Session state persists after restart

## 11. Risk Notes

- If Codex still does not recognize `codex-to-im`, the issue is likely install/discovery rather than repository code.
- If the daemon starts but old data is not found, it is likely still reading the new default path `~/.codex-to-im` while the historical data remains in `~/.claude-to-im`.
- If someone renames the internal `claude-to-im` package without updating imports and exports together, builds will break.
