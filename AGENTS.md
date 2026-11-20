# Project Instructions (OpenCode)

Before executing any task, read and follow all rules in `CLAUDE.md`, `nestjs-project/CLAUDE.md`, and `.claude/rules/`.

## Environment Overrides (Podman)
- Every `npm`, `npx`, `tsc`, and `jest` command MUST run inside the container via `podman compose exec nestjs-api <command>` (never on the host).
- Always run test suites sequentially with `--runInBand`.
- Follow the project pipeline skills in `.claude/skills/<skill>/SKILL.md` in order: `research` → `plan-context` → `plan-validate` → `plan-resolve` → `plan-build` → `implement`.