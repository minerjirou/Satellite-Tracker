import * as THREE from 'three';
import { EARTH_RADIUS } from '../lib/units';

/**
 * 画面座標での最近傍探索によるピッキング。
 *
 * GPU ピッキング(色分けした ID を別パスに描いて読み戻す)も考えられるが、
 * 13,000 点の射影は 1ms 未満で終わるうえ、「クリック位置に一番近い点」という
 * 直感的な当たり判定になるので、点が小さくても掴みやすい。
 */

const scratch = new THREE.Vector3();

export interface PickOptions {
  positions: Float32Array;
  count: number;
  /** 表示中のグループのマスク。隠れている衛星は掴めないようにする。 */
  masks: Int32Array;
  filterMask: number;
  camera: THREE.PerspectiveCamera;
  /** 正規化デバイス座標 (-1..1) */
  ndcX: number;
  ndcY: number;
  /** 判定半径(px) */
  radiusPx: number;
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * @returns 最も近い衛星の添字。範囲内に無ければ -1。
 */
export function pickSatellite(options: PickOptions): number {
  const { positions, count, masks, filterMask, camera, ndcX, ndcY, radiusPx } = options;
  const halfWidth = options.viewportWidth / 2;
  const halfHeight = options.viewportHeight / 2;

  const targetX = ndcX * halfWidth;
  const targetY = ndcY * halfHeight;
  const radiusSq = radiusPx * radiusPx;

  camera.updateMatrixWorld();
  const viewProjection = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );

  // 地球に隠れている衛星を掴まないための判定に使う
  const cameraPosition = camera.position;
  const earthRadiusSq = EARTH_RADIUS * EARTH_RADIUS;

  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = 0; i < count; i += 1) {
    if ((masks[i]! & filterMask) === 0) continue;

    const o = i * 3;
    const x = positions[o]!;
    if (!Number.isFinite(x)) continue;
    const y = positions[o + 1]!;
    const z = positions[o + 2]!;

    scratch.set(x, y, z).applyMatrix4(viewProjection);
    // カメラの後ろ(w < 0 で反転したもの)は除外
    if (scratch.z < -1 || scratch.z > 1) continue;

    const dx = scratch.x * halfWidth - targetX;
    const dy = scratch.y * halfHeight - targetY;
    const distSq = dx * dx + dy * dy;
    if (distSq > radiusSq) continue;

    // 地球の裏側にある点は候補から外す。
    // カメラ→衛星の線分が地球球体と交わるかを、その最近接距離で判定する。
    if (isOccludedByEarth(cameraPosition, x, y, z, earthRadiusSq)) continue;

    // 画面上の近さを優先し、同程度ならカメラに近い方を採る
    const score = distSq + scratch.z * 0.001;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex;
}

/**
 * カメラと衛星を結ぶ線分が地球に遮られているか。
 * 線分上で地球中心に最も近い点を求め、それが地表より内側なら遮蔽と判定する。
 */
function isOccludedByEarth(
  camera: THREE.Vector3,
  x: number,
  y: number,
  z: number,
  earthRadiusSq: number,
): boolean {
  // 地表より内側の座標は伝播の破綻なので掴ませない
  if (x * x + y * y + z * z < earthRadiusSq) return true;

  const dx = x - camera.x;
  const dy = y - camera.y;
  const dz = z - camera.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  if (lengthSq === 0) return false;

  const t = -(camera.x * dx + camera.y * dy + camera.z * dz) / lengthSq;
  // 最近接点が線分の外なら、カメラ側の端か衛星側の端が最も近い = 遮られていない
  if (t <= 0 || t >= 1) return false;

  const px = camera.x + dx * t;
  const py = camera.y + dy * t;
  const pz = camera.z + dz * t;
  return px * px + py * py + pz * pz < earthRadiusSq;
}
