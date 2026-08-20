import * as THREE from 'three';
import { CATEGORY_STYLES, type Category } from '../data/groups';
import { STATE_OK, STATE_SUNLIT } from '../workers/protocol';

/**
 * 全衛星を 1 つの THREE.Points で描く。
 *
 * 13,000 基を個別の Mesh にするとドローコールで死ぬので、単一のジオメトリに
 * まとめてカスタムシェーダで色・サイズ・表示可否を出し分ける。
 *
 * グループの絞り込みはシェーダ内のビット演算で行う。CPU 側で毎回ジオメトリを
 * 組み直す必要がなく、チェックボックスの操作が uniform 1 つの更新で済む。
 */

const vertexShader = /* glsl */ `
  in vec3 aColor;
  in float aSize;
  in float aLit;
  in int aMask;
  in float aThin;

  uniform int uFilterMask;
  uniform int uThinnableMask;
  uniform float uThinThreshold;
  uniform float uPointScale;
  uniform float uMinSize;
  uniform float uMaxSize;
  uniform int uSelectedIndex;
  uniform float uUnlitDim;

  out vec3 vColor;
  out float vSelected;

  const vec4 CULLED = vec4(2.0, 2.0, 2.0, 1.0);

  void main() {
    bool selected = (gl_VertexID == uSelectedIndex);

    // 伝播に失敗した衛星は NaN が入っている
    if (!(position.x == position.x)) {
      gl_Position = CULLED;
      gl_PointSize = 0.0;
      return;
    }

    // グループフィルタ。選択中の衛星だけは絞り込みを無視して必ず出す。
    if (!selected && (aMask & uFilterMask) == 0) {
      gl_Position = CULLED;
      gl_PointSize = 0.0;
      return;
    }

    // 遠景での間引き。大規模コンステレーションだけが対象で、
    // 有人・GNSS などは常に全数残る。
    if (!selected && (aMask & uThinnableMask) != 0 && aThin > uThinThreshold) {
      gl_Position = CULLED;
      gl_PointSize = 0.0;
      return;
    }

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float distance = max(-mvPosition.z, 0.001);
    float size = uPointScale * aSize / distance;
    gl_PointSize = clamp(size, uMinSize, uMaxSize) * (selected ? 2.2 : 1.0);

    // 地球の影に入っている衛星は少し落とす。夜側を横切る様子が分かる。
    vColor = aColor * mix(uUnlitDim, 1.0, aLit);
    vSelected = selected ? 1.0 : 0.0;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  in vec3 vColor;
  in float vSelected;
  out vec4 fragColor;

  void main() {
    vec2 offset = gl_PointCoord - vec2(0.5);
    float d = length(offset);
    if (d > 0.5) discard;

    // 中心が明るく縁が柔らかい点。四角いピクセルの塊に見えないようにする。
    float alpha = smoothstep(0.5, 0.15, d);

    vec3 color = vColor;
    if (vSelected > 0.5) {
      // 選択中はリング状に強調する
      float ring = smoothstep(0.28, 0.36, d) * smoothstep(0.5, 0.42, d);
      color = mix(color, vec3(1.0), ring * 0.9);
      alpha = max(alpha, ring);
    }

    fragColor = vec4(color, alpha);
  }
`;

export interface FieldStats {
  /** フィルタとして有効な(=表示対象になりうる)衛星数 */
  visible: number;
}

export class SatelliteField {
  readonly points: THREE.Points;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly litAttr: THREE.BufferAttribute;

  /** 直近に Worker から受け取った位置(シーン単位) */
  private basePositions: Float32Array;
  private baseVelocities: Float32Array;
  private states: Uint8Array;
  /** 描画に使う外挿後の位置。ピッキングもこれを見る。 */
  private readonly renderPositions: Float32Array;

  readonly count: number;
  readonly masks: Int32Array;

  constructor(
    count: number,
    categories: Uint8Array,
    masks: Int32Array,
    thinKeys: Float32Array,
    thinnableMask: number,
  ) {
    this.count = count;
    this.masks = masks;

    this.renderPositions = new Float32Array(count * 3);
    this.basePositions = new Float32Array(count * 3);
    this.baseVelocities = new Float32Array(count * 3);
    this.states = new Uint8Array(count);

    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const lit = new Float32Array(count);

    for (let i = 0; i < count; i += 1) {
      const style = CATEGORY_STYLES[categories[i] as Category] ?? CATEGORY_STYLES[14 as Category];
      const o = i * 3;
      colors[o] = style.color[0];
      colors[o + 1] = style.color[1];
      colors[o + 2] = style.color[2];
      sizes[i] = style.sizeScale;
      lit[i] = 1;
      // 初期位置は原点だと地球の中心に固まるので、描画対象外にしておく
      this.renderPositions[o] = Number.NaN;
    }

    this.geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.renderPositions, 3);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.litAttr = new THREE.BufferAttribute(lit, 1);
    this.litAttr.setUsage(THREE.DynamicDrawUsage);

    const maskAttr = new THREE.BufferAttribute(masks, 1);
    maskAttr.gpuType = THREE.IntType;

    this.geometry.setAttribute('position', this.positionAttr);
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    this.geometry.setAttribute('aLit', this.litAttr);
    this.geometry.setAttribute('aMask', maskAttr);
    this.geometry.setAttribute('aThin', new THREE.BufferAttribute(thinKeys, 1));

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uFilterMask: { value: -1 },
        uThinnableMask: { value: thinnableMask },
        uThinThreshold: { value: 1 },
        uPointScale: { value: 100 },
        uMinSize: { value: 1.3 },
        uMaxSize: { value: 11 },
        uSelectedIndex: { value: -1 },
        uUnlitDim: { value: 0.45 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    // 位置が毎フレーム変わるので three 側のバウンディング計算は無意味。自前で切らない。
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  /**
   * Worker から届いた新しいサンプルを受け取る。
   * @returns 入れ替わって不要になった前回のバッファ。Worker に返して再利用させる。
   */
  setSample(
    positions: Float32Array,
    velocities: Float32Array,
    states: Uint8Array,
  ): { positions: Float32Array; velocities: Float32Array; states: Uint8Array } | null {
    const recycled =
      this.basePositions.length > 0
        ? { positions: this.basePositions, velocities: this.baseVelocities, states: this.states }
        : null;

    this.basePositions = positions;
    this.baseVelocities = velocities;
    this.states = states;

    const lit = this.litAttr.array as Float32Array;
    for (let i = 0; i < this.count; i += 1) {
      const state = states[i]!;
      lit[i] = (state & STATE_OK) === 0 ? 0 : (state & STATE_SUNLIT) !== 0 ? 1 : 0;
    }
    this.litAttr.needsUpdate = true;
    return recycled;
  }

  /**
   * 直近サンプルからの経過時間ぶん位置を外挿する。
   *
   * 20Hz のサンプルを 60fps で描くために毎フレーム呼ぶ。速度で 1 次外挿しており、
   * 50ms 先の誤差は 1cm 程度(向心加速度 8.7m/s^2 × 0.05^2 / 2)なので、
   * 補間のために 1 サンプル遅らせるより素直で、しかも遅延がない。
   */
  extrapolate(dtSeconds: number): void {
    const base = this.basePositions;
    const vel = this.baseVelocities;
    const out = this.renderPositions;
    const states = this.states;
    if (base.length !== out.length) return;

    for (let i = 0; i < this.count; i += 1) {
      const o = i * 3;
      if ((states[i]! & STATE_OK) === 0) {
        out[o] = Number.NaN;
        continue;
      }
      out[o] = base[o]! + vel[o]! * dtSeconds;
      out[o + 1] = base[o + 1]! + vel[o + 1]! * dtSeconds;
      out[o + 2] = base[o + 2]! + vel[o + 2]! * dtSeconds;
    }
    this.positionAttr.needsUpdate = true;
  }

  /** ピッキング用。描画に使っているのと同じ配列。 */
  get positions(): Float32Array {
    return this.renderPositions;
  }

  isValid(index: number): boolean {
    return (this.states[index]! & STATE_OK) !== 0;
  }

  setFilterMask(mask: number): void {
    this.material.uniforms.uFilterMask!.value = mask;
  }

  setSelected(index: number): void {
    this.material.uniforms.uSelectedIndex!.value = index;
  }

  /**
   * カメラの引き具合に応じて点サイズと間引き率を決める。
   *
   * @param viewportHeight 描画バッファの高さ(px)
   * @param fovRadians 垂直画角
   * @param cameraDistance 地球中心からのカメラ距離(シーン単位)
   */
  updateView(
    viewportHeight: number,
    fovRadians: number,
    cameraDistance: number,
    thinningEnabled: boolean,
  ): void {
    // 1 シーン単位の球が画面上で何 px になるかの係数
    const projection = viewportHeight / (2 * Math.tan(fovRadians / 2));
    this.material.uniforms.uPointScale!.value = projection * 0.018;

    if (!thinningEnabled) {
      this.material.uniforms.uThinThreshold!.value = 1;
      return;
    }
    // 地球が画面に収まる程度(距離 20 前後)から間引きを始め、
    // 引き切った状態(距離 90 以上)で 3 割まで減らす
    const t = THREE.MathUtils.clamp((cameraDistance - 18) / (90 - 18), 0, 1);
    this.material.uniforms.uThinThreshold!.value = THREE.MathUtils.lerp(1, 0.3, t);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
