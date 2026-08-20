import { useState } from 'react';
import { formatAzimuth, formatDuration, formatJstShort } from '../lib/format';
import type { Observer, PassPrediction } from '../workers/protocol';

interface Props {
  satelliteName: string | null;
  observer: Observer | null;
  passes: PassPrediction[] | null;
  busy: boolean;
  error: string | null;
  onUseCurrentLocation(): void;
  onManualObserver(latDeg: number, lonDeg: number): void;
  onRequest(): void;
}

export function PassesPanel(props: Props) {
  const [lat, setLat] = useState('35.681');
  const [lon, setLon] = useState('139.767');

  return (
    <div className="panel">
      <h2 className="panel-title">可視パス予測</h2>

      {!props.satelliteName && <p className="hint">衛星を選択すると、今後48時間のパスを計算できます。</p>}

      <div className="observer-row">
        <button type="button" className="btn btn-compact" onClick={props.onUseCurrentLocation}>
          現在地を使う
        </button>
        <span className="hint-inline">または</span>
        <input
          className="coord-input"
          type="number"
          step="0.001"
          value={lat}
          aria-label="観測地の緯度"
          onChange={(event) => setLat(event.target.value)}
        />
        <input
          className="coord-input"
          type="number"
          step="0.001"
          value={lon}
          aria-label="観測地の経度"
          onChange={(event) => setLon(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-compact"
          onClick={() => props.onManualObserver(Number(lat), Number(lon))}
        >
          設定
        </button>
      </div>

      {props.observer && (
        <p className="hint">
          観測地: {props.observer.latitudeDeg.toFixed(3)}°, {props.observer.longitudeDeg.toFixed(3)}°
        </p>
      )}

      <button
        type="button"
        className="btn btn-accent btn-block"
        onClick={props.onRequest}
        disabled={props.busy || !props.satelliteName || !props.observer}
      >
        {props.busy ? '計算中…' : '今後48時間のパスを計算'}
      </button>

      {props.error && <p className="warning">{props.error}</p>}

      {props.passes && props.passes.length === 0 && (
        <p className="hint">
          今後48時間で仰角 10° を超えるパスはありませんでした。
          （観測地の緯度と軌道傾斜角の関係で、そもそも見えない衛星もあります）
        </p>
      )}

      {props.passes && props.passes.length > 0 && (
        <>
          <p className="hint">
            仰角 10° 以上のパス {props.passes.length} 件。
            <span className="visible-mark">●</span> は衛星が日照中かつ空が暗く、
            肉眼で見える見込みがあるものです。
          </p>
          <ul className="pass-list">
            {props.passes.map((pass) => (
              <li key={pass.startMs} className={`pass-item ${pass.visible ? 'is-visible' : ''}`}>
                <div className="pass-head">
                  {pass.visible && <span className="visible-mark" title="肉眼可視の見込み">●</span>}
                  <span className="pass-time">{formatJstShort(pass.startMs)}</span>
                  <span className="pass-duration">{formatDuration(pass.endMs - pass.startMs)}</span>
                  <span className="pass-elevation">最大 {Math.round(pass.maxElevationDeg)}°</span>
                </div>
                <div className="pass-detail">
                  {formatAzimuth(pass.startAzimuthDeg)} → {formatAzimuth(pass.peakAzimuthDeg)} →{' '}
                  {formatAzimuth(pass.endAzimuthDeg)}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
