# AGENTS.md - Compose Tutor Studio

## Goal

Build a beginner-friendly composition app with integrated music theory tutorials. The MVP must let users create, learn, save, and export a short original song.

## Repo Expectations

- Monorepo with `apps/desktop` and `packages/*`.
- Use TypeScript strict mode.
- Use small, testable packages.
- Keep domain logic independent from UI.
- Prefer pure functions for theory and tutorial checking.

## Commands

Use the actual package scripts once created. Expected commands:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm dev
pnpm build
```

## Coding Standards

- No hidden network calls.
- No copyrighted sample assets.
- No DAW UI cloning.
- No giant PRs. Keep tasks small.
- Add tests for every non-trivial music theory rule.
- Explain beginner-facing messages in plain language.

## Architecture Constraints

- UI: React + TypeScript
- Desktop: Tauri
- Backend: Rust commands
- Audio MVP: Web Audio + AudioWorklet
- Data: SQLite or versioned local project bundle
- AI Coach: optional adapter with mock implementation

## Testing Requirements

Before completing a task, run the smallest relevant test command. For theory, run all `theory-engine` tests. For UI changes, run component tests or a smoke E2E if available.

## References

Detailed requirements are in:

- `docs/01_product_requirements.md`
- `docs/02_feature_specification.md`
- `docs/03_tutorial_learning_spec.md`
- `docs/05_technical_architecture.md`
- `docs/06_data_model.md`
- `schemas/openapi.yaml`

## Completion Response Format

When finishing a task, report:

- What changed
- Tests run
- Known limitations
- Suggested next task
