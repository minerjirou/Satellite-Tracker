import { formatJst, formatRate, formatUtc } from '../lib/format';

const RATES = [1, 10, 60, 600, 3600];

interface Props {
  simTimeMs: number;
  rate: number;
  paused: boolean;
  offsetHours: number;
  onRate(rate: number): void;
  onTogglePaused(): void;
  onOffsetHours(hours: number): void;
  onResetToNow(): void;
}

export function TimeControls(props: Props) {
  const { simTimeMs, rate, paused, offsetHours } = props;
  const offLabel =
    Math.abs(offsetHours) < 0.05
      ? '現在時刻'
      : `${offsetHours > 0 ? '+' : '−'}${Math.abs(offsetHours).toFixed(1)} 時間`;

  return (
    <div className="panel time-controls">
      <div className="time-readout">
        <div className="time-primary">{formatJst(simTimeMs)}</div>
        <div className="time-secondary">{formatUtc(simTimeMs)}</div>
      </div>

      <div className="time-row">
        <button
          type="button"
          className={`btn ${paused ? 'btn-accent' : ''}`}
          onClick={props.onTogglePaused}
          aria-pressed={paused}
        >
          {paused ? '▶ 再生' : '❚❚ 一時停止'}
        </button>

        <div className="rate-group" role="group" aria-label="再生速度">
          {RATES.map((value) => (
            <button
              key={value}
              type="button"
              className={`btn btn-compact ${rate === value ? 'btn-active' : ''}`}
              onClick={() => props.onRate(value)}
              title={formatRate(value)}
            >
              {value === 1 ? '1×' : value < 3600 ? `${value}×` : '1h/s'}
            </button>
          ))}
          <button
            type="button"
            className={`btn btn-compact ${rate < 0 ? 'btn-active' : ''}`}
            onClick={() => props.onRate(rate < 0 ? 1 : -60)}
            title="時間を巻き戻す"
          >
            ◀◀
          </button>
        </div>
      </div>

      <div className="time-row">
        <label className="slider-label" htmlFor="time-offset">
          {offLabel}
        </label>
        <input
          id="time-offset"
          className="slider"
          type="range"
          min={-48}
          max={48}
          step={0.25}
          value={offsetHours}
          onChange={(event) => props.onOffsetHours(Number(event.target.value))}
        />
        <button type="button" className="btn btn-compact" onClick={props.onResetToNow}>
          今へ
        </button>
      </div>
    </div>
  );
}
