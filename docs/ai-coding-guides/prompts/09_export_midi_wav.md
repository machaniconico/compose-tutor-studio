# Prompt 09 - Export MIDI/WAV

Implement export MVP.

MIDI:

- write tempo
- write time signature
- write separate tracks
- export notes
- include chord markers if practical, otherwise write sidecar JSON

WAV:

- offline render internal synth/drum only
- warn if unsupported tracks exist

Acceptance:

- exported MIDI imports into common DAWs with note timing preserved
- exported WAV duration matches selected range approximately
- export errors are user-readable
