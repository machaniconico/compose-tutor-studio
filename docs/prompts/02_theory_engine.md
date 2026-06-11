# Prompt 02 - Theory Engine MVP

Implement the first version of `packages/theory-engine`.

Functions:

- parseNoteName(input)
- midiToNoteName(midi, options)
- buildScale(root, scaleName)
- parseChordSymbol(symbol)
- analyzeChord({ symbol, key, scale })
- getDiatonicChords(key, scale)
- suggestNextChords({ key, scale, currentProgression })
- analyzeNoteAgainstChordAndScale(note, chord, key, scale)

Required tests:

- C major scale
- A natural minor scale
- C, Dm, G7, Am, Fmaj7 parse
- C-G-Am-F in C major => I-V-vi-IV
- G7 in C major => V7 dominant
- E7 -> Am in C major should be tagged as secondary dominant candidate

Keep the implementation deterministic and dependency-light.
