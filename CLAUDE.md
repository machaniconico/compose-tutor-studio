# CLAUDE.md - Compose Tutor Studio

## Project Mission

Build an education-integrated composition desktop app. The app should help beginners complete original short songs while learning DAW operations, chord theory, scales, arrangement, and basic mixing.

## Primary Product Rule

Do not build a full professional DAW clone first. Build the smallest reliable product where a beginner can create an 8-16 bar original song, understand why the musical choices work, save it, and export MIDI/WAV.

## Tech Stack

- Tauri 2 desktop shell
- React 19 + TypeScript + Vite
- Web Audio API + AudioWorklet for MVP audio
- Rust backend for filesystem, SQLite, and export commands
- Packages:
  - `theory-engine`
  - `project-model`
  - `tutorial-engine`
  - `midi-io`
  - `ui-kit`

## Implementation Rules

- Use TypeScript strict mode.
- Keep theory logic pure and covered by unit tests.
- Separate state, rendering, and domain logic.
- Do not put heavy work in audio realtime callbacks.
- Use deterministic tests for theory and tutorial logic.
- Do not copy UI, icons, text, presets, samples, or manuals from existing DAWs.
- Treat DAW names as research references only.
- Do not add external network calls unless explicitly scoped.
- AI Coach must be optional and mockable.
- Default behavior must keep project/audio data local.

## Definition of Done

For every task:

1. Code compiles.
2. Relevant unit tests pass.
3. Typecheck passes.
4. No new unhandled TODOs in production paths.
5. Docs are updated when behavior changes.
6. User-facing text is beginner-friendly.

## Preferred Workflow

1. Read the relevant docs in `docs/`.
2. Make a small implementation plan.
3. Add or update tests first for domain logic.
4. Implement the smallest passing change.
5. Run tests and typecheck.
6. Summarize changed files and remaining risks.

## Key Documents

- `docs/01_product_requirements.md`
- `docs/02_feature_specification.md`
- `docs/03_tutorial_learning_spec.md`
- `docs/05_technical_architecture.md`
- `docs/06_data_model.md`
- `schemas/openapi.yaml`

## Musical Correctness Rules

- Always distinguish pitch class, octave-specific MIDI note, scale degree, and chord tone.
- Do not assume all non-scale notes are wrong. Explain context: passing tone, approach tone, tension, blues note, borrowed color, etc.
- Beginner mode should simplify explanations.
- Advanced mode can include secondary dominants, borrowed chords, tensions, and voice leading.

## Safety / Legal Rules

- Do not implement prompts or UI that ask for copying a living artist's style or a specific copyrighted song.
- Do not bundle samples unless their license is explicitly documented.
- Do not implement VST/AU hosting until licensing and crash isolation are separately approved.
- Do not upload audio/project data without explicit user consent.
