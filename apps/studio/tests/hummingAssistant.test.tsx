import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HummingMelodyAssistant } from '../src/features/hummingToMelody/HummingMelodyAssistant';

describe('HummingMelodyAssistant', () => {
  it('explains the local file workflow and destructive apply boundary', () => {
    const html = renderToStaticMarkup(<HummingMelodyAssistant />);
    expect(html).toContain('鼻歌からメロディ');
    expect(html).toContain('端末内で解析');
    expect(html).toContain('録音済みファイル');
    expect(html).toContain('32 MB・60秒まで');
    expect(html).toContain('鼻歌ファイルを選ぶ');
  });
});
