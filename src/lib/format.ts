/** 表示用の書式まわり。UTC と JST を併記するのが基本方針。 */

const utcFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const jstFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const jstShort = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export const formatUtc = (ms: number): string =>
  Number.isFinite(ms) ? `${utcFormatter.format(new Date(ms))} UTC` : '—';

export const formatJst = (ms: number): string =>
  Number.isFinite(ms) ? `${jstFormatter.format(new Date(ms))} JST` : '—';

export const formatJstShort = (ms: number): string =>
  Number.isFinite(ms) ? jstShort.format(new Date(ms)) : '—';

/** 「3時間12分前」のような相対表記 */
export function formatRelative(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const diff = Date.now() - ms;
  const future = diff < 0;
  const abs = Math.abs(diff);

  const minutes = Math.floor(abs / 60000);
  if (minutes < 1) return 'たった今';
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return future ? `${minutes}分後` : `${minutes}分前`;
  const days = Math.floor(hours / 24);
  if (days < 1) {
    const rest = minutes % 60;
    const text = rest > 0 ? `${hours}時間${rest}分` : `${hours}時間`;
    return future ? `${text}後` : `${text}前`;
  }
  return future ? `${days}日後` : `${days}日前`;
}

export function formatNumber(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('ja-JP', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, '0')}秒` : `${seconds}秒`;
}

const COMPASS = [
  '北', '北北東', '北東', '東北東',
  '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西',
  '西', '西北西', '北西', '北北西',
];

/** 方位角(度)を十六方位に */
export function formatAzimuth(deg: number): string {
  if (!Number.isFinite(deg)) return '—';
  const index = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return `${COMPASS[index]} (${Math.round(deg)}°)`;
}

/** 緯度経度を N/S・E/W 付きで */
export function formatLatLon(latDeg: number, lonDeg: number): string {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return '—';
  const ns = latDeg >= 0 ? 'N' : 'S';
  const ew = lonDeg >= 0 ? 'E' : 'W';
  return `${Math.abs(latDeg).toFixed(3)}°${ns}  ${Math.abs(lonDeg).toFixed(3)}°${ew}`;
}

/** 時間倍率の表示名 */
export function formatRate(rate: number): string {
  if (rate === 1) return '実時間';
  if (Math.abs(rate) >= 3600) return `${rate / 3600}時間/秒`;
  if (Math.abs(rate) >= 60) return `${rate / 60}分/秒`;
  return `${rate}×`;
}
