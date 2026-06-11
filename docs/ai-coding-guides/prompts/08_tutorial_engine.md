# Prompt 08 - Tutorial Engine MVP

Implement tutorial engine.

Features:

- Lesson DSL loader
- event bus integration
- checkers:
  - hasChordProgression
  - hasNotesWithinScale
  - hasBassRootOnDownbeat
  - hasDrumPattern
  - hasExported
- LearnPanel display
- Progress persistence interface

Create Course 0 lessons from the spec.

Acceptance:

- placing C-G-Am-F completes the chord progression step
- creating a simple drum pattern completes the drum step
- feedback includes result, reason, next action
