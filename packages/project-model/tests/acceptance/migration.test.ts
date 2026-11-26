import { describe, expect, it } from 'vitest';
import { soundingEvents } from '../../src/sounding';
import { CURRENT_SCHEMA_VERSION, PROJECT_TEMPLATES, deserializeProject, instantiateTemplate, serializeProject, validateProject } from '../../src/index';
import type { Project, TemplateId } from '../../src/index';
import { legacyLiveEvents } from './legacyOracle';
import { fromSounding, mulberry32, tickOf, type Rng } from './helpers';

const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
type Raw = Record<string, any>;

/**
 * A seeded v1/v2 file. 4 slots of 8 beats per track (clips never overlap, even once their length is
 * stretched to their content), all content inside the 8-bar song, loops and links with their own content.
 */
function legacyFile(seed: number, version: 1 | 2): Raw {
  const r = mulberry32(seed);
  const ts: [number, number] = r() < 0.5 ? [4, 4] : [3, 4];
  const bpb = ts[0];
  const slot = 8;
  const tracks: Raw[] = [];
  const kinds = ['instrument', 'drum', 'instrument'].concat(version === 2 ? [r() < 0.5 ? 'bus' : 'audio'] : []);
  let n = 0;
  kinds.forEach((kind, ti) => {
    const id = `t${ti}`;
    const clips: Raw[] = [];
    for (let s = 0; s < 4; s++) {
      if (r() < 0.25) continue;
      const loop = r() < 0.5;
      const clip: Raw = {
        id: `c${ti}-${s}`, trackId: id, type: kind === 'drum' ? 'drum' : 'midi',
        startBeat: s * slot, lengthBeats: int(r, 1, 6), loop,
      };
      if (loop && r() < 0.7) clip.contentLengthBeats = int(r, 1, 3) * 0.5;
      if (r() < 0.4 && clips.length > 0) clip.aliasOf = (clips[0] as Raw).id;
      if (kind === 'drum') {
        clip.stepsPerBar = 16;
        clip.drumEvents = Array.from({ length: int(r, 0, 5) }, () => ({ id: `d${n++}`, lane: ['kick', 'snare', 'closedHat'][int(r, 0, 2)], stepIndex: int(r, 0, Math.floor(((slot - 1) * 16) / bpb)), velocity: int(r, 1, 127) }));
      } else {
        clip.notes = Array.from({ length: int(r, 0, 5) }, () => ({ id: `n${n++}`, pitch: int(r, 40, 90), startBeat: int(r, 0, 6) / 2, durationBeats: int(r, 1, 6) / 4, velocity: int(r, 1, 127) }));
      }
      clips.push(clip);
    }
    tracks.push({ id, name: kind === 'drum' ? 'Drums' : `Track ${ti}`, type: kind, clips, volume: 0.8, pan: 0, mute: false, solo: false, effects: [] });
  });
  tracks.push({ id: 'master', name: 'Master', type: 'master', clips: [], volume: 0.5, pan: 0, mute: false, solo: false, effects: [] });
  return {
    id: `legacy-${seed}`, schemaVersion: version, title: 'legacy', bpm: 100 + (seed % 40), timeSignature: ts, key: 'C', scale: 'major',
    lengthBars: Math.ceil((4 * slot) / bpb), tracks, chordTrack: [], sections: [],
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
  };
}

const LEGACY_SEEDS = Array.from({ length: 100 }, (_, i) => 7000 + i);

describe('migration (US-007b)', () => {
  it('migration.legacyOracle: v1/v2 の生成ファイル(seed 固定)で、移行後の soundingEvents の発音が旧 events.ts 凍結コピー(テスト内オラクル)の旧ライブ発音と一致する', () => {
    let loopsOrLinks = 0;
    for (const version of [1, 2] as const) {
      for (const seed of LEGACY_SEEDS) {
        const file = legacyFile(seed, version);
        loopsOrLinks += (file.tracks as Raw[]).flatMap((t) => t.clips as Raw[]).filter((c) => c.loop || c.aliasOf).length;
        const oracle = legacyLiveEvents(file).map((e) => ({ kind: e.kind, trackId: e.trackId, startBeat: e.beat, durationBeats: e.kind === 'note' ? e.durationBeats : undefined, pitch: e.kind === 'note' ? e.pitch : undefined, lane: e.kind === 'drum' ? e.lane : undefined, velocity: e.velocity }));
        const migrated = deserializeProject(JSON.stringify(file));
        expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
        const now = fromSounding(soundingEvents(migrated).events);
        expect(now).toEqual(fromSounding(oracle));
      }
    }
    expect(loopsOrLinks).toBeGreaterThan(100); // the files really contain loops and links
  });

  it('migration.legacyOracle: v1/v2 の loop・aliasOf・contentLengthBeats が legacyClipSettings に退避され、再生用の loop/aliasOf は外れている', () => {
    let saved = 0;
    for (const version of [1, 2] as const) {
      for (const seed of LEGACY_SEEDS) {
        const file = legacyFile(seed, version);
        const migrated = deserializeProject(JSON.stringify(file));
        const rawClips = new Map((file.tracks as Raw[]).flatMap((t) => t.clips as Raw[]).map((c) => [c.id, c]));
        for (const clip of migrated.tracks.flatMap((t) => t.clips)) {
          const old = rawClips.get(clip.id) as Raw;
          expect(clip.loop).toBe(false);
          expect(clip.aliasOf).toBeUndefined();
          expect(clip.contentLengthBeats).toBeUndefined();
          if (old.loop || old.aliasOf !== undefined || old.contentLengthBeats !== undefined) {
            saved += 1;
            expect(clip.legacyClipSettings).toEqual({
              loop: old.loop === true,
              ...(old.aliasOf !== undefined ? { aliasOf: old.aliasOf } : {}),
              ...(old.contentLengthBeats !== undefined ? { contentLengthBeats: old.contentLengthBeats } : {}),
            });
          } else {
            expect(clip.legacyClipSettings).toBeUndefined();
          }
        }
      }
    }
    expect(saved).toBeGreaterThan(100);
  });

  it('migration.legacyOracle: v3 のファイルは書かれた loop・リンクどおりに読み込み、書き換えない', () => {
    const v3: Project = deserializeProject(JSON.stringify(legacyFile(7001, 2)));
    const withLoop: Project = {
      ...v3,
      tracks: v3.tracks.map((t, i) => (i === 0 ? { ...t, clips: t.clips.map((c) => ({ ...c, loop: true, contentLengthBeats: 1 })) } : t)),
    };
    const again = deserializeProject(serializeProject(withLoop));
    expect(again.tracks[0]?.clips.every((c) => c.loop === true && c.contentLengthBeats === 1)).toBe(true);
  });

  it('migration.roundTrip: 保存 → 読込 → 保存が同一バイト(全テンプレートと移行後ファイル。legacyClipSettings が保持される)', () => {
    const projects: Project[] = (Object.keys(PROJECT_TEMPLATES) as TemplateId[]).map((id) => instantiateTemplate(id));
    for (const version of [1, 2] as const) {
      for (const seed of LEGACY_SEEDS.slice(0, 25)) projects.push(deserializeProject(JSON.stringify(legacyFile(seed, version))));
    }
    let retained = 0;
    for (const p of projects) {
      expect(validateProject(p).ok).toBe(true);
      const first = serializeProject(p);
      const loaded = deserializeProject(first);
      expect(serializeProject(loaded)).toBe(first);
      for (const c of p.tracks.flatMap((t) => t.clips)) {
        if (c.legacyClipSettings) {
          retained += 1;
          expect(loaded.tracks.flatMap((t) => t.clips).find((x) => x.id === c.id)?.legacyClipSettings).toEqual(c.legacyClipSettings);
        }
      }
    }
    expect(retained).toBeGreaterThan(20);
    expect(tickOf(1)).toBeGreaterThan(0);
  });
});
