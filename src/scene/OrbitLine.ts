import * as THREE from 'three';

/**
 * 選択中の衛星の軌道線(慣性系)と地上軌跡(地球固定系)。
 *
 * どちらも「途切れることがある線」なので Line ではなく LineSegments で描く。
 * ・軌道線: 伝播に失敗したサンプルで切れる
 * ・地上軌跡: 経度が ±180° をまたぐところで切る。切らないと地図の端から端へ
 *   横断する直線が引かれてしまう。
 */

/**
 * 連続点列を LineSegments 用の頂点ペアに展開する。
 * NaN を含む点と、breaks で指定された位置で線を切る。
 */
function toSegments(points: Float32Array, breaks?: Int32Array): Float32Array {
  const breakSet = breaks ? new Set(Array.from(breaks)) : null;
  const count = points.length / 3;
  const out: number[] = [];

  for (let i = 1; i < count; i += 1) {
    if (breakSet?.has(i)) continue;

    const a = (i - 1) * 3;
    const b = i * 3;
    if (!Number.isFinite(points[a]!) || !Number.isFinite(points[b]!)) continue;

    out.push(points[a]!, points[a + 1]!, points[a + 2]!);
    out.push(points[b]!, points[b + 1]!, points[b + 2]!);
  }

  return Float32Array.from(out);
}

/** 進行方向に沿って色が薄くなるグラデーション。どちら向きに進むのか一目で分かる。 */
function fadeColors(segmentCount: number, color: THREE.Color, headAlpha: number): Float32Array {
  const colors = new Float32Array(segmentCount * 2 * 3);
  for (let s = 0; s < segmentCount; s += 1) {
    const t = segmentCount > 1 ? s / (segmentCount - 1) : 0;
    // 現在地(t=0)が濃く、1 周先(t=1)へ向かって薄くなる
    const k = headAlpha * (1 - t) + 0.12 * t;
    for (let v = 0; v < 2; v += 1) {
      const o = (s * 2 + v) * 3;
      colors[o] = color.r * k;
      colors[o + 1] = color.g * k;
      colors[o + 2] = color.b * k;
    }
  }
  return colors;
}

class Trail {
  readonly object: THREE.LineSegments;
  private geometry: THREE.BufferGeometry;
  private readonly material: THREE.LineBasicMaterial;
  /** ユーザーがこの線を表示したがっているか。衛星を選び直しても保たれる。 */
  private desiredVisible = true;
  private hasData = false;

  constructor(color: THREE.Color, private readonly headAlpha: number, renderOrder: number) {
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.material.color = color;
    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = renderOrder;
    this.object.visible = false;
  }

  set(points: Float32Array, breaks?: Int32Array): void {
    const vertices = toSegments(points, breaks);
    const segmentCount = vertices.length / 6;

    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();

    if (segmentCount === 0) {
      this.object.geometry = this.geometry;
      this.hasData = false;
      this.object.visible = false;
      return;
    }

    this.geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    this.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(fadeColors(segmentCount, this.material.color, this.headAlpha), 3),
    );
    this.object.geometry = this.geometry;
    this.hasData = true;
    // 衛星を選び直しただけで、消しておいた線が復活しないようにする
    this.object.visible = this.desiredVisible;
  }

  clear(): void {
    this.hasData = false;
    this.object.visible = false;
  }

  setVisible(visible: boolean): void {
    this.desiredVisible = visible;
    this.object.visible = visible && this.hasData;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export class OrbitTrails {
  /** 慣性系。シーン直下に置く。 */
  readonly orbit: Trail;
  /** 地球固定系。Earth の surfaceGroup に入れて一緒に回す。 */
  readonly groundTrack: Trail;

  constructor() {
    this.orbit = new Trail(new THREE.Color(0.45, 0.85, 1.0), 1.0, 2);
    this.groundTrack = new Trail(new THREE.Color(1.0, 0.72, 0.3), 0.85, 2);
  }

  set(points: Float32Array, groundTrack: Float32Array, groundBreaks: Int32Array): void {
    this.orbit.set(points);
    this.groundTrack.set(groundTrack, groundBreaks);
  }

  clear(): void {
    this.orbit.clear();
    this.groundTrack.clear();
  }

  dispose(): void {
    this.orbit.dispose();
    this.groundTrack.dispose();
  }
}
