/**
 * シーンのスケール定義。
 *
 * three.js の深度バッファ精度を確保するため、1 シーン単位 = 1,000km としている。
 * これで地球半径 6.371、GEO 42.164 という扱いやすい数値になり、
 * near=0.01 / far=1000 の素直なカメラ設定で LEO から GEO まで破綻なく描ける。
 */
export const KM_PER_UNIT = 1000;

/** 地球平均半径 (km)。テクスチャが正距円筒図法なので真球として扱う。 */
export const EARTH_RADIUS_KM = 6371.0088;

export const EARTH_RADIUS = EARTH_RADIUS_KM / KM_PER_UNIT;

/** 静止軌道半径 (km)。カメラの引き切り距離の基準に使う。 */
export const GEO_RADIUS_KM = 42164;

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const kmToUnits = (km: number): number => km / KM_PER_UNIT;
export const unitsToKm = (u: number): number => u * KM_PER_UNIT;

/**
 * 測地緯度経度を真球上の直交座標に変換する。
 * 正距円筒図法のテクスチャと同じ前提(緯度=極角)なので、
 * 地上軌跡とテクスチャ上の海岸線がずれない。
 */
export function geodeticToScene(
  latRad: number,
  lonRad: number,
  radiusUnits: number,
  out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): { x: number; y: number; z: number } {
  const cosLat = Math.cos(latRad);
  out.x = radiusUnits * cosLat * Math.cos(lonRad);
  out.y = radiusUnits * Math.sin(latRad);
  out.z = -radiusUnits * cosLat * Math.sin(lonRad);
  return out;
}

/**
 * ECI(z が北極) から three.js の Y-up 座標へ。
 * ECI の z を three.js の y に、ECI の y を three.js の -z に割り当てる。
 * geodeticToScene と同じ約束なので、両者を同じシーンに混ぜても整合する。
 */
export function eciToScene(
  x: number,
  y: number,
  z: number,
  out: Float32Array | number[],
  offset = 0,
): void {
  out[offset] = x / KM_PER_UNIT;
  out[offset + 1] = z / KM_PER_UNIT;
  out[offset + 2] = -y / KM_PER_UNIT;
}
