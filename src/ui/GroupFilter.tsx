import { GROUP_LABELS } from '../data/groups';
import type { CatalogInfo } from '../app/useTracker';

interface Props {
  catalog: CatalogInfo;
  isGroupEnabled(name: string): boolean;
  onToggle(name: string): void;
  onSetAll(enabled: boolean): void;
  thinning: boolean;
  onThinning(value: boolean): void;
}

export function GroupFilter(props: Props) {
  const { catalog } = props;

  if (!catalog.hasGroups) {
    return (
      <div className="panel">
        <h2 className="panel-title">グループ</h2>
        <p className="hint">
          グループ所属データがまだ投入されていません。軌道の形から推定した分類で色分けしています。
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title">グループで絞り込む</h2>
        <div className="panel-actions">
          <button type="button" className="link-btn" onClick={() => props.onSetAll(true)}>
            全表示
          </button>
          <button type="button" className="link-btn" onClick={() => props.onSetAll(false)}>
            全非表示
          </button>
        </div>
      </div>

      <ul className="group-list">
        {catalog.groupNames.map((name) => {
          const enabled = props.isGroupEnabled(name);
          const count = catalog.groupCounts[name] ?? 0;
          return (
            <li key={name}>
              <label className={`group-item ${enabled ? '' : 'is-off'}`}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={() => props.onToggle(name)}
                />
                <span className="group-name">{GROUP_LABELS[name] ?? name}</span>
                <span className="group-count">{count.toLocaleString('ja-JP')}</span>
              </label>
            </li>
          );
        })}
      </ul>

      {catalog.ungroupedCount > 0 && (
        <p className="hint">
          どのグループにも属さない {catalog.ungroupedCount.toLocaleString('ja-JP')} 基は、
          軌道の形（低軌道 / 中軌道 / 長楕円）で分類しています。
        </p>
      )}

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={props.thinning}
          onChange={(event) => props.onThinning(event.target.checked)}
        />
        <span>
          遠景で大規模コンステレーションを間引く
          <span className="hint-inline">（Starlink などが密集して見づらいときに）</span>
        </span>
      </label>
    </div>
  );
}
