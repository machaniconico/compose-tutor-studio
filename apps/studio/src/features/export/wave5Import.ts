import {
  convertWave5Project,
  decodeProjectJson,
  type Project,
  type ProjectDecodeErrorCode,
  type Wave5ConvertErrorCode,
  type Wave5ReportCode,
  type Wave5ReportItem,
  type Wave5ReportSeverity,
} from '@cts/project-model';

export type Wave5ReportLine = { code: Wave5ReportCode; severity: Wave5ReportSeverity; text: string };

export type Wave5ImportConversion =
  | { ok: true; project: Project; report: Wave5ReportItem[]; lines: Wave5ReportLine[] }
  | { ok: false; code: Wave5ConvertErrorCode; message: string };

export type Wave5ConversionOffer = {
  kind: 'offer-conversion';
  code: 'legacy-wave5-format';
  message: string;
  convert: () => Wave5ImportConversion;
};

export type ProjectJsonImportInput = string | { bytes: Uint8Array; legacyWave5?: boolean };
export type Wave5ImportPlan =
  | { kind: 'open'; project: Project }
  | Wave5ConversionOffer
  | { kind: 'error'; code: ProjectDecodeErrorCode; message: string };

function importError(code: ProjectDecodeErrorCode): Wave5ImportPlan {
  return {
    kind: 'error', code,
    message: code === 'future-schema-version'
      ? 'このファイルは新しいアプリ版で作成されています。アプリを更新してください。'
      : 'プロジェクトファイルを安全に検証できませんでした。',
  };
}

export function planProjectJsonImport(input: ProjectJsonImportInput): Wave5ImportPlan {
  let text: string;
  try {
    text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  } catch {
    return importError('invalid-json');
  }
  const decoded = decodeProjectJson(text);
  if (!decoded.ok && decoded.error.code === 'legacy-wave5-format') {
    return {
      kind: 'offer-conversion',
      code: 'legacy-wave5-format',
      message: '以前の曲ファイルです。このアプリで開けるように変換しますか？',
      convert: () => {
        const result = convertWave5Project(JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text));
        return result.ok
          ? { ...result, lines: describeWave5Report(result.report, result.project) }
          : { ok: false, code: result.code, message: result.reason };
      },
    };
  }
  if (typeof input !== 'string' && input.legacyWave5) return importError('invalid-project');
  return decoded.ok ? { kind: 'open', project: decoded.project } : importError(decoded.error.code);
}

function describeItem({ code, detail }: Wave5ReportItem): string {
  switch (code) {
    case 'legacy-bar-limit-dropped': return '以前の小節数の上限設定を外しました。';
    case 'loop-range-dropped': return '曲の繰り返し再生範囲を引き継げませんでした。';
    case 'legacy-clip-settings-dropped': return '以前のクリップ設定を外しました。';
    case 'loop-unrolled': return '繰り返し部分を並べて書き出しました。';
    case 'drum-loop-snapped': return '繰り返したドラムの音を近くのマスに移しました。';
    case 'link-materialized': return '連動していたクリップを個別に編集できるようにしました。';
    case 'link-broken': return '参照先を使えないクリップの連動を外しました。';
    case 'link-cyclic': return '互いを参照していたクリップの連動を外しました。';
    case 'duplicate-role-demoted': return '重複した練習用の役割を通常のトラックに変更しました。';
    case 'send-dropped': return '別のトラックに音を送る設定を外しました。';
    case 'automation-lane-dropped': return '時間に合わせて音を変える設定を引き継げませんでした。';
    case 'automation-point-dropped': return `重なっていた設定点や曲の終わりより後の設定点を ${detail?.count ?? 0} 個整理しました。`;
    case 'audio-clip-unresolved': return '音声ファイルが見つからないため、この部分は鳴りません。';
    case 'chord-track-audible': return 'コード伴奏が鳴るようになります。止めるにはコードトラックをミュートしてください。';
    case 'effects-approximated': return '音の加工を引き継ぎました。元の曲と響きが異なる場合があります。';
    case 'effect-adjusted': return '音の加工設定を、このアプリで使える範囲に調整しました。';
    case 'effect-dropped': return 'このアプリで使えない音の加工を外しました。';
    case 'hidden-events-dropped': return `再生できない音を ${detail?.count ?? 0} 個取り除きました。`;
    case 'song-end-trimmed': return '曲の終わりを越えた部分を取り除きました。';
    case 'drum-hits-merged': return `同じマスに入ったドラムの音をまとめ、強い音を残しました（${detail?.count ?? 0} 個を整理）。`;
    case 'clip-type-changed': return '音が鳴るように、クリップの種類をトラックに合わせました。';
    case 'overlap-split': return '重なったクリップを別のトラックに分けました。';
  }
}

export function describeWave5Report(report: Wave5ReportItem[], project: Project): Wave5ReportLine[] {
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  const clips = new Map(project.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)));
  const [numerator, denominator] = project.timeSignature;
  const beatsPerBar = numerator * 4 / denominator;
  return report.map((item) => {
    const clip = item.clipId === undefined ? undefined : clips.get(item.clipId);
    const trackId = clip?.trackId ?? item.trackId;
    const track = trackId === undefined ? undefined : tracks.get(trackId);
    const position = clip
      ? ` ${Math.floor(clip.startBeat / beatsPerBar) + 1}小節目 ${Math.floor(clip.startBeat % beatsPerBar) + 1}拍目`
      : '';
    const location = track ? `「${track.name}」${position}　` : '';
    return { code: item.code, severity: item.severity, text: location + describeItem(item) };
  });
}
