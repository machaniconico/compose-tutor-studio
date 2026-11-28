# P70 fixtures (wave5 v3 converter)

Golden answers for the P70 acceptance tests (`../../p70-*.test.ts(x)`, Rust block at the end of
`apps/desktop/src-tauri/src/native_persistence/tests.rs`). Do not edit by hand; regenerate.

- `inputs/<name>.json`: a wave5 v3 project (the converter input). 55 files: the wave5 app default
  (`default-app`), the package default (`default-empty`), the sample song, all 8 wave5 templates, 2 projects made
  ONLY with wave5's own edit functions (`return-reverb`, `realistic-song`) and 39 hand-built projects, one or more per
  converter rule (see `manifest.json` for the description of each).
- **Baseline = the wave5 LOAD path.** Every golden below is computed from `deserializeProject(JSON.stringify(input))`
  (migrate + `normalizeClipDomain`), because that is what the wave5 app plays. It detaches broken/cyclic/type-mismatched/
  content-owning links, rewires link chains to the root, caps `lengthBars` at 64 (unless `legacyBarLimit`), and moves
  overlapping clips onto `<track>-overlap-<n>` tracks. Switching the generator from the raw project to this path left 34 of
  the first 35 `.events.json` files byte-identical; the only difference was `link-broken-cyclic.events.json`
  (its `problems` list: the load path detaches the links, so wave5 no longer reports them), and that fixture was then extended.
- `expected/<name>.events.json`: what wave5's REAL `soundingEvents(loaded, { includeMuted: true })` plays,
  taken from commit **d85f796** (tag `wave5-desktop-final`). Normalized to PPQ 480 ticks, sorted. Open hats
  that a closed hat chokes carry `chokeEndTick`. `problems` is wave5's own list of silent clips. The
  `over-limit-events` file has only the count (24576; its event list is not needed).
- `expected/<name>.lanes.json`: wave5's REAL `evaluateAutomation` on the loaded project, sampled every 1/8 beat from beat 0
  to the song end, already in MAIN's units (volume = fader x lane, pan = clamp(pan + lane), cutoff = log2(multiplier)).
  Only lanes wave5 actually plays: never Master lanes, cutoff only on instrument tracks. The test evaluates the converted
  lanes with main's `automationValueAt` and compares within 1e-6.
- `manifest.json`: index; `wave5Valid` says whether wave5's own `validateProject` accepts the LOADED project
  (`sends` and `lanes-unplayable` are deliberately not valid wave5 files: a dangling send, Master/drum/bus lanes wave5 rejects;
  wave5 still plays them).
- `converted/` (git-ignored): written by the TS test `convert_output_passesDecodeCurrentProject_andRustValidate`;
  read by the Rust test `p70_converted_fixtures_pass_native_validation`. Without `CTS_P70_REQUIRE_CONVERTED=1` it SKIPS
  CLEANLY (prints why) while the directory is empty; WITH `CTS_P70_REQUIRE_CONVERTED=1` an empty/short directory FAILS.
  CI's desktop job must run the TS test first and then `cargo test` with the variable set.
- Expected values for every non-event rule (roles, lane formulas, sends, swing, macros, reports, limits) are
  hand-computed literals inside the tests. Nothing in this directory is produced by converter code.

## Regenerate

Needs only a checkout of d85f796 (no `pnpm install` there) and the repo's `tsx`.

```bash
REPO=<this repo>                       # e.g. /home/macha/workspace/compose-tutor-studio
W5=/home/macha/workspace/_scratch/w5-d85f796
git -C "$REPO" worktree add --detach "$W5" d85f796

# tsconfig that maps the wave5 app's `@cts/project-model` import to the d85f796 source
cat > /tmp/p70-tsconfig.json <<JSON
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
  "allowImportingTsExtensions": true, "strict": false, "skipLibCheck": true, "baseUrl": "/",
  "paths": { "@cts/project-model": ["$W5/packages/project-model/src/index.ts"] } } }
JSON

cd "$W5"
W5_ROOT="$W5" P70_OUT="$REPO/apps/studio/tests/acceptance/fixtures/p70" \
  "$REPO/node_modules/.pnpm/node_modules/.bin/tsx" --tsconfig /tmp/p70-tsconfig.json \
  "$REPO/apps/studio/tests/acceptance/fixtures/p70/generator/generate.mts"

git -C "$REPO" worktree remove --force "$W5"     # nothing was committed there
```

`generator/generate.mts` stubs `Date`, `Date.now` and `Math.random` (the wave5 app ids use them), builds the
projects (`mixer-effects`, `return-reverb` and `realistic-song` with wave5's own `upsertEffect`, `addReverbReturn`,
`setTrackSend`, `addNoteToClip`, `addTrack`, `resizeClip`, `duplicateClip`, `splitClip`, `toggleDrumStep`, `addPoint`, ...;
only `loop` / `contentLengthBeats` / `swing` are set directly, as the wave5 UI does), loads each through `deserializeProject`,
validates with wave5's `validateProject`, runs wave5's `soundingEvents` and `evaluateAutomation`, and writes the files.
Regenerating must produce identical bytes; if it does not, the generator is not deterministic and must be fixed
before the fixtures are touched. After regenerating, update `.omc/state/acceptance-tests.sha256`
(`sha256sum -c` lists what moved).

## Hand-built fixture index (what each is for)

| fixture | test |
|---|---|
| `meter-6-8-bpm90` | bpmAndMeter |
| `roles` | roles |
| `lane-volume` / `lane-pan` / `lane-cutoff` | volume / pan / cutoff lanes |
| `lane-equal-beats`, `lane-equal-beats-at-zero` | equalBeatPoints, extra at beat 0 |
| `sends` | sends (also has a send to a missing return and a level-0 send) |
| `loop-no-content-length` | loopWithoutContentLength |
| `loop-content-length`, `loop-drum-content-length`, `loop-drum-offgrid-period` | loopWithContentLength (+ drum snap extra) |
| `drum-same-step-hits`, `loop-drum-snap-collision` | drum hits wave5 plays but main cannot hold (same lane and step): `drum-hits-merged` (extras) |
| `clip-type-mismatch-played` | drum-typed clip holding notes on an instrument track, wave5 plays it: `clip-type-changed` (extra) |
| `link-chain`, `link-cross-track`, `link-length-mismatch`, `link-broken-cyclic`, `link-of-looped-source` | link rules |
| `swing` | swing |
| `macros` | macros |
| `legacy-fields` | legacyBarLimit / loopRange / legacyClipSettings |
| `over-limit-steps`, `over-limit-events` | overLimit (refused fixtures) |
| `audio-clips` | audioClips |
| `mixer-effects`, `effects-order-eq-enabled`, `effects-order-eq-disabled`, `effects-adjusted` | effect table, order, adjusted/dropped effects, mute/solo/fader/pan, chord track, sections |
| `return-reverb`, `realistic-song` | made with wave5's own edit functions |
| `lane-first-point-late`, `lanes-unplayable` | lane start value, Master/drum/bus lanes |
| `swing-loop-cut` | stored length of a cut note under swing |
| `song-end`, `song-length-80` | song-end trimming (clips, chords, sections; lengthBars 80 -> 64) |
| `overlap-clips` | wave5 load splits overlapping clips onto an overlap track |
| `link-longer`, `link-drum`, `drum-no-steps-3-4`, `loop-false-with-content-length`, `type-mismatch-content` | more link/loop/drum/type edges |
| `over-limit-density` | 300 notes in 0.3 beat (256 per 0.75 beat limit) |
