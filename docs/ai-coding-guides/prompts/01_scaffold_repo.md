# Prompt 01 - Scaffold Repository

You are implementing Compose Tutor Studio. Create the initial monorepo scaffold.

Requirements:

- pnpm workspace
- apps/desktop: Tauri + React + TypeScript + Vite
- packages/theory-engine
- packages/project-model
- packages/tutorial-engine
- packages/midi-io
- packages/ui-kit
- shared lint/typecheck/test scripts
- strict TypeScript config
- placeholder app layout with TopBar, TrackList, Timeline, EditorPane, LearnPanel

Do not implement audio yet. Do not add network calls.

Definition of done:

- `pnpm install` works
- `pnpm typecheck` works
- `pnpm test` works with placeholder tests
- `pnpm dev` launches the desktop app or web dev shell
