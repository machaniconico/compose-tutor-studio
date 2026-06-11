# Prompt 07 - Audio Playback MVP

Implement minimal audio playback.

Features:

- Transport clock
- Lookahead scheduler
- Simple synth for instrument tracks
- Drum sample or generated drum tones
- Metronome toggle
- Track volume/mute/solo

Constraints:

- Do not block UI thread with heavy processing.
- Keep implementation replaceable by future native engine.
- No external network audio resources.

Acceptance:

- pressing Space starts/stops playback
- notes in Piano Roll play at correct approximate timing
- drum pattern plays in sync
