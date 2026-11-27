// プリセット名 → General MIDI プログラム番号(0 起点、0〜127)の対応表。
// GM のプログラム番号は公開規格。音色名は番号の説明用で、近い音色を選んだだけです。

/** 未知のプリセット・楽器なしのときの既定(Warm Pad)。 */
export const DEFAULT_GM_PROGRAM = 89;

const GM_PROGRAM_BY_PRESET: Readonly<Record<string, number>> = {
  // 基本の 4 音色
  softPad: 89, // やわらかいパッド -> Warm Pad
  brightPluck: 46, // 明るいはじき音 -> Orchestral Harp
  warmBass: 38, // まるいベース -> Synth Bass 1
  brightLead: 81, // 明るいリード -> Sawtooth Lead
  // 追加の 10 音色(P22。保存名は "p22:" 付き)
  pianoLike: 0, // ピアノ風 -> Acoustic Grand Piano
  bell: 14, // ベル -> Tubular Bells
  organLike: 16, // オルガン風 -> Drawbar Organ
  stringsLike: 48, // ストリングス風 -> String Ensemble 1
  brassLike: 61, // ブラス風 -> Brass Section
  pluck: 45, // ピチカート風 -> Pizzicato Strings
  deepSubBass: 39, // 深い低音 -> Synth Bass 2
  softKeys: 4, // やわらかい鍵盤 -> Electric Piano 1
  squareLead: 80, // 角のあるリード -> Square Lead
  glassPad: 92, // すきとおるパッド -> Bowed Pad
  // 旧名(エイリアス)
  warmPad: 89, // 旧 softPad
  pad: 89, // 旧 softPad
  roundBass: 38, // 旧 warmBass
  subBass: 38, // 旧 warmBass
  bass: 38, // 旧 warmBass
  leadSine: 81, // 旧 brightLead
  lead: 81, // 旧 brightLead
};

/** プリセット名からプログラム番号を返す。"p22:" 接頭辞は無視し、未知なら既定。 */
export function gmProgramForPreset(preset: unknown): number {
  if (typeof preset !== 'string') return DEFAULT_GM_PROGRAM;
  const name = preset.startsWith('p22:') ? preset.slice(4) : preset;
  return Object.hasOwn(GM_PROGRAM_BY_PRESET, name)
    ? GM_PROGRAM_BY_PRESET[name]!
    : DEFAULT_GM_PROGRAM;
}

// 逆引き用の正規プリセット名(エイリアスは含めない。保存名は P22 のものに "p22:" が付く)。
const CANONICAL_PRESETS = [
  'softPad', 'brightPluck', 'warmBass', 'brightLead',
  'p22:pianoLike', 'p22:bell', 'p22:organLike', 'p22:stringsLike', 'p22:brassLike',
  'p22:pluck', 'p22:deepSubBass', 'p22:softKeys', 'p22:squareLead', 'p22:glassPad',
] as const;

const PRESET_BY_PROGRAM: ReadonlyMap<number, string> = new Map(
  CANONICAL_PRESETS.map((preset) => [gmProgramForPreset(preset), preset]),
);

/** プログラム番号に対応する正規プリセットを返す。1 対 1 で戻せないときは undefined。 */
export function presetForGmProgram(program: number): string | undefined {
  return PRESET_BY_PROGRAM.get(program);
}
