import { useState } from 'react';

import { useTracker } from './useTracker';
import { TimeControls } from '../ui/TimeControls';
import { GroupFilter } from '../ui/GroupFilter';
import { SearchBox } from '../ui/SearchBox';
import { DetailPanel } from '../ui/DetailPanel';
import { PassesPanel } from '../ui/PassesPanel';
import { formatRelative } from '../lib/format';

export function App() {
  const tracker = useTracker();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const { status, catalog, detail } = tracker;

  return (
    <div className="app">
      <canvas ref={tracker.canvasRef} className="scene-canvas" />

      {status.phase !== 'ready' && (
        <div className="overlay">
          <div className="overlay-card">
            <h1 className="overlay-title">Satellite Tracker</h1>
            {status.phase === 'loading' ? (
              <>
                <div className="spinner" aria-hidden="true" />
                <p>{status.message}</p>
                <p className="hint">
                  CelesTrak の実測軌道要素から、いま地球を回っている衛星を描画します。
                </p>
              </>
            ) : (
              <>
                <p className="error-title">{status.message}</p>
                {status.error && <pre className="error-detail">{status.error}</pre>}
                <button type="button" className="btn btn-accent" onClick={() => location.reload()}>
                  再読み込み
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Satellite Tracker</span>
          {catalog && (
            <span className="brand-sub">
              {catalog.count.toLocaleString('ja-JP')} 基を追跡中
              {catalog.fetchedAt && ` · 軌道要素 ${formatRelative(Date.parse(catalog.fetchedAt))}`}
            </span>
          )}
        </div>
        <div className="topbar-right">
          {tracker.hoverName && <span className="hover-name">{tracker.hoverName}</span>}
          <button
            type="button"
            className="btn btn-compact sidebar-toggle"
            onClick={() => setSidebarOpen((open) => !open)}
            aria-expanded={sidebarOpen}
          >
            {sidebarOpen ? '◀ パネルを隠す' : '▶ パネル'}
          </button>
        </div>
      </header>

      {status.phase === 'ready' && (
        <>
          <aside className={`sidebar ${sidebarOpen ? '' : 'is-collapsed'}`}>
            <SearchBox
              search={tracker.search}
              onSelect={tracker.select}
              onFocus={tracker.focusSelected}
            />

            {catalog && (
              <GroupFilter
                catalog={catalog}
                isGroupEnabled={tracker.isGroupEnabled}
                onToggle={tracker.toggleGroup}
                onSetAll={tracker.setAllGroups}
                thinning={tracker.thinning}
                onThinning={tracker.setThinning}
              />
            )}

            <PassesPanel
              satelliteName={detail?.name ?? null}
              observer={tracker.observer}
              passes={tracker.passes}
              busy={tracker.passesBusy}
              error={tracker.passesError}
              onUseCurrentLocation={tracker.useCurrentLocation}
              onManualObserver={tracker.setManualObserver}
              onRequest={tracker.requestPasses}
            />

            <div className="panel credits">
              <p>
                軌道要素:{' '}
                <a href="https://celestrak.org/" target="_blank" rel="noreferrer">
                  CelesTrak
                </a>
                （2 時間ごとに更新）
              </p>
              <p>
                地球テクスチャ: NASA Earth Observatory — Blue Marble / Earth at Night
                （パブリックドメイン）
              </p>
              <p>
                伝播: SGP4/SDP4 (satellite.js{catalog?.usingWasm ? ' · WASM' : ''})
              </p>
              {catalog?.groupsFetchedAt && (
                <p>グループ所属: {formatRelative(Date.parse(catalog.groupsFetchedAt))}に更新</p>
              )}
            </div>
          </aside>

          {detail && catalog && (
            <div className="detail-dock">
              <DetailPanel
                detail={detail}
                groupNames={catalog.groupNames}
                follow={tracker.follow}
                onFollow={tracker.setFollow}
                showOrbit={tracker.showOrbit}
                onShowOrbit={tracker.setShowOrbit}
                showGround={tracker.showGround}
                onShowGround={tracker.setShowGround}
                onFocus={tracker.focusSelected}
                onClose={() => tracker.select(-1)}
              />
            </div>
          )}

          <footer className="bottombar">
            <TimeControls
              simTimeMs={tracker.simTimeMs}
              rate={tracker.rate}
              paused={tracker.paused}
              offsetHours={tracker.offsetHours}
              onRate={tracker.setRate}
              onTogglePaused={tracker.togglePaused}
              onOffsetHours={tracker.setOffsetHours}
              onResetToNow={tracker.resetToNow}
            />
          </footer>
        </>
      )}
    </div>
  );
}
