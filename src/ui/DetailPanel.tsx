import { CATEGORY_STYLES, GROUP_LABELS, type Category } from '../data/groups';
import {
  formatJst,
  formatLatLon,
  formatNumber,
  formatRelative,
  formatUtc,
} from '../lib/format';
import type { SatelliteDetail } from '../workers/protocol';

interface Props {
  detail: SatelliteDetail;
  groupNames: string[];
  follow: boolean;
  onFollow(value: boolean): void;
  showOrbit: boolean;
  onShowOrbit(value: boolean): void;
  showGround: boolean;
  onShowGround(value: boolean): void;
  onFocus(): void;
  onClose(): void;
}

/** マスクからグループ名を並べる(定義順) */
function groupsOf(mask: number, names: string[]): string[] {
  const out: string[] = [];
  names.forEach((name, bit) => {
    if (mask & (1 << bit)) out.push(name);
  });
  return out;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className="detail-value">{value}</span>
    </div>
  );
}

export function DetailPanel(props: Props) {
  const { detail } = props;
  const style = CATEGORY_STYLES[detail.category as Category];
  const groups = groupsOf(detail.mask, props.groupNames);

  const rgb = style
    ? `rgb(${style.color.map((c) => Math.round(c * 255)).join(',')})`
    : '#8ab4f8';

  // TLE のエポックから離れるほど誤差が増える。1 週間を目安に注意を出す。
  const epochAgeDays = (Date.now() - detail.epochMs) / 86400000;
  const epochStale = Number.isFinite(epochAgeDays) && Math.abs(epochAgeDays) > 7;

  const sunState = !Number.isFinite(detail.shadowFraction)
    ? '—'
    : detail.shadowFraction < 0.05
      ? '日照中'
      : detail.shadowFraction > 0.95
        ? '地球の影(本影)'
        : `半影 (${Math.round(detail.shadowFraction * 100)}% 遮蔽)`;

  return (
    <div className="panel detail-panel">
      <div className="panel-header">
        <h2 className="panel-title">
          <span className="category-dot" style={{ background: rgb }} aria-hidden="true" />
          {detail.name}
        </h2>
        <button type="button" className="link-btn" onClick={props.onClose} aria-label="詳細を閉じる">
          ✕
        </button>
      </div>

      <div className="tag-row">
        {groups.length > 0 ? (
          groups.map((name) => (
            <span key={name} className="tag">
              {GROUP_LABELS[name] ?? name}
            </span>
          ))
        ) : (
          <span className="tag tag-muted">{style?.label ?? '未分類'}（軌道形状から推定）</span>
        )}
      </div>

      {detail.error !== 0 && (
        <p className="warning">
          この衛星は現在の時刻で軌道計算が破綻しています（SGP4 エラー {detail.error}）。
          再突入済みか、軌道要素が古すぎる可能性があります。
        </p>
      )}

      <div className="detail-grid">
        <Row label="NORAD ID" value={String(detail.noradId)} />
        <Row label="国際識別符号" value={detail.intlDes || '—'} />
        <Row label="高度" value={`${formatNumber(detail.altitudeKm)} km`} />
        <Row label="対地速度" value={`${formatNumber(detail.speedKmPerSec, 3)} km/s`} />
        <Row label="現在位置" value={formatLatLon(detail.latitudeDeg, detail.longitudeDeg)} />
        <Row label="軌道傾斜角" value={`${formatNumber(detail.inclinationDeg, 2)}°`} />
        <Row label="離心率" value={detail.eccentricity.toFixed(6)} />
        <Row label="周期" value={`${formatNumber(detail.periodMinutes, 2)} 分`} />
        <Row
          label="遠地点 / 近地点"
          value={`${formatNumber(detail.apogeeKm, 0)} / ${formatNumber(detail.perigeeKm, 0)} km`}
        />
        <Row label="日照状態" value={sunState} />
      </div>

      <div className="detail-actions">
        <button type="button" className="btn btn-compact" onClick={props.onFocus}>
          カメラを寄せる
        </button>
        <label className="toggle-row toggle-inline">
          <input
            type="checkbox"
            checked={props.follow}
            onChange={(event) => props.onFollow(event.target.checked)}
          />
          <span>追従</span>
        </label>
        <label className="toggle-row toggle-inline">
          <input
            type="checkbox"
            checked={props.showOrbit}
            onChange={(event) => props.onShowOrbit(event.target.checked)}
          />
          <span>軌道線</span>
        </label>
        <label className="toggle-row toggle-inline">
          <input
            type="checkbox"
            checked={props.showGround}
            onChange={(event) => props.onShowGround(event.target.checked)}
          />
          <span>地上軌跡</span>
        </label>
      </div>

      <details className="tle-details">
        <summary>
          軌道要素 (TLE) — エポック {formatRelative(detail.epochMs)}
          {epochStale && <span className="warning-inline"> ⚠ 古い</span>}
        </summary>
        <div className="epoch-line">
          {formatJst(detail.epochMs)}
          <br />
          {formatUtc(detail.epochMs)}
        </div>
        <pre className="tle-block">
          {detail.name}
          {'\n'}
          {detail.tleLine1}
          {'\n'}
          {detail.tleLine2}
        </pre>
      </details>
    </div>
  );
}
