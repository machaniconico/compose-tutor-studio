import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HummingMelodyAssistant } from '../src/features/hummingToMelody/HummingMelodyAssistant';

describe('HummingMelodyAssistant', () => {
  it('offers direct microphone capture and a local-file fallback without uploading audio', () => {
    const html = renderToStaticMarkup(<HummingMelodyAssistant />);
    expect(html).toContain('鼻歌からメロディ');
    expect(html).toContain('端末内で解析');
    expect(html).toContain('録音データや解析結果を外部へ送信しません');
    expect(html).toContain('マイクで鼻歌を録音');
    expect(html).toContain('録音済みファイル');
    expect(html).toContain('マイク録音は60秒まで（保存しません）');
    expect(html).toContain('32 MB・60秒まで');
    expect(html).toContain('録音済みファイルを選ぶ');
  });
});
