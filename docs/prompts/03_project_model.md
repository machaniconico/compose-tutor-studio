# Prompt 03 - Project Model

Implement `packages/project-model`.

Create TypeScript schemas and validators for:

- Project
- Track
- Clip
- NoteEvent
- DrumEvent
- ChordEvent
- Section
- LessonProgress

Add defaults:

- 120 BPM
- C major
- 4/4
- 8 bars
- tracks: Chords, Drums, Bass, Melody, Master

Add tests for:

- valid default project
- invalid BPM
- invalid pitch
- save/load roundtrip JSON
- schema version field
