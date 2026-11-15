import { useState } from 'react';
import { useStore } from '../../state/store';
import { searchGlossary } from './glossary';

/** 用語集の一覧と検索(ひらがな・カタカナ・英字のどれでも部分一致)。 */
export function GlossaryPanel() {
  const difficulty = useStore((s) => s.editor.difficulty);
  const [query, setQuery] = useState('');
  const results = searchGlossary(query);

  return (
    <div className="glossary-panel">
      <input
        type="search"
        className="glossary-panel__search"
        value={query}
        placeholder="用語をさがす(例: すうぃんぐ、swing)"
        aria-label="用語をさがす"
        onChange={(ev) => setQuery(ev.target.value)}
      />
      {results.length === 0 ? (
        <p className="glossary-panel__empty">見つかりませんでした。別の書き方で試してください。</p>
      ) : (
        <dl className="glossary-panel__list">
          {results.map((entry) => (
            <div key={entry.id} className="glossary-panel__item">
              <dt>{entry.label}</dt>
              <dd>{entry.description[difficulty]}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
