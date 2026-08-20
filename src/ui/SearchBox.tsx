import { useMemo, useState } from 'react';
import type { SearchHit } from '../app/useTracker';

interface Props {
  search(query: string): SearchHit[];
  onSelect(index: number): void;
  onFocus(): void;
}

export function SearchBox(props: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const hits = useMemo(() => (query.trim() ? props.search(query) : []), [query, props]);

  const choose = (hit: SearchHit) => {
    props.onSelect(hit.index);
    props.onFocus();
    setQuery(hit.name);
    setOpen(false);
  };

  return (
    <div className="panel search-panel">
      <label className="visually-hidden" htmlFor="satellite-search">
        衛星を検索
      </label>
      <input
        id="satellite-search"
        className="search-input"
        type="search"
        placeholder="衛星名 または NORAD ID で検索"
        value={query}
        autoComplete="off"
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && hits[0]) choose(hits[0]);
          if (event.key === 'Escape') setOpen(false);
        }}
      />

      {open && hits.length > 0 && (
        <ul className="search-results">
          {hits.map((hit) => (
            <li key={hit.index}>
              <button type="button" className="search-hit" onClick={() => choose(hit)}>
                <span className="hit-name">{hit.name}</span>
                <span className="hit-id">{hit.noradId}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && query.trim().length > 0 && hits.length === 0 && (
        <p className="hint search-empty">該当する衛星がありません</p>
      )}
    </div>
  );
}
