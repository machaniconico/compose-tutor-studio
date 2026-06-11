# Prompt 04 - Main Layout

Implement the main studio layout in `apps/desktop`.

UI regions:

- TopBar: project title, BPM, key, scale, transport, export button
- TrackList
- Timeline with placeholder grid
- ChordTrack lane
- EditorPane tabs: Piano Roll / Drums / Clip
- LearnPanel
- TheoryInspector placeholder

State:

- create default project from project-model
- display project BPM/key/scale
- no audio yet

Acceptance:

- layout renders without console errors
- basic keyboard shortcut Space toggles play state visually
- LearnPanel can be collapsed
