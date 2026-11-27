import { describe, expect, it } from 'vitest';
import { GLOSSARY, searchGlossary, segmentGlossaryText } from '../src/features/tutorial/glossary';

describe('glossary', () => {
  it('has at least 40 unique terms', () => {
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(40);
    expect(new Set(GLOSSARY.map((g) => g.id)).size).toBe(GLOSSARY.length);
  });

  it('has a non-empty description for every term', () => {
    for (const entry of GLOSSARY) {
      expect(entry.description.trim(), entry.id).not.toBe('');
    }
  });

  it('returns the same term for hiragana and english queries', () => {
    const a = searchGlossary('りばーぶ').map((g) => g.id);
    const b = searchGlossary('reverb').map((g) => g.id);
    expect(a).toEqual(['reverb']);
    expect(b).toEqual(a);
  });

  it('normalizes katakana and returns all terms for an empty query', () => {
    expect(searchGlossary('リバーブ').map((g) => g.id)).toEqual(['reverb']);
    expect(searchGlossary('')).toHaveLength(GLOSSARY.length);
    expect(searchGlossary('zzzz')).toEqual([]);
  });
});

describe('segmentGlossaryText', () => {
  it('wraps a term and keeps the surrounding text', () => {
    expect(segmentGlossaryText('この4コードを覚える')).toEqual([
      'この4',
      { id: 'chord', text: 'コード' },
      'を覚える',
    ]);
  });

  it('prefers the longest label', () => {
    expect(segmentGlossaryText('コード進行です')).toEqual([
      { id: 'chord-progression', text: 'コード進行' },
      'です',
    ]);
    expect(segmentGlossaryText('サブドミナント')).toEqual([{ id: 'subdominant', text: 'サブドミナント' }]);
  });

  it('wraps only the first occurrence of each term', () => {
    expect(segmentGlossaryText('コードとコード')).toEqual([{ id: 'chord', text: 'コード' }, 'とコード']);
  });

  it('does not treat a repeated longer term as its shorter part', () => {
    expect(segmentGlossaryText('コード進行とコード進行')).toEqual([
      { id: 'chord-progression', text: 'コード進行' },
      'とコード進行',
    ]);
  });

  it('skips labels that are part of another word', () => {
    for (const text of ['キーボード', 'グループ', 'レコード', '拍手', 'XBPMX']) {
      expect(segmentGlossaryText(text)).toEqual([text]);
    }
  });

  it('does not explain the snare sound as stereo pan', () => {
    expect(segmentGlossaryText('スネアは「パン」という音')).toEqual(['スネアは「パン」という音']);
  });

  it('returns no segments for empty text', () => {
    expect(segmentGlossaryText('')).toEqual([]);
  });
});

describe('glossary matches this app', () => {
  it('has no entry for features this app does not have', () => {
    const ids = GLOSSARY.map((g) => g.id);
    expect(ids).not.toContain('swing');
    expect(ids).not.toContain('quantize');
  });

  it('explains automation Read/Bypass, sends and the tempo map', () => {
    const text = (id: string) => GLOSSARY.find((g) => g.id === id)?.description ?? '';
    expect(text('automation')).toMatch(/Read/);
    expect(text('automation')).toMatch(/Bypass/);
    expect(text('pre-post-fader')).toMatch(/フェーダー前/);
    expect(text('tempo-map')).not.toBe('');
  });
});
