import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { Earth } from './Earth';
import { Atmosphere } from './Atmosphere';
import { Starfield } from './Starfield';
import { SatelliteField } from './SatelliteField';
import { OrbitTrails } from './OrbitLine';
import { pickSatellite } from './picking';
import { EARTH_RADIUS, GEO_RADIUS_KM, KM_PER_UNIT } from '../lib/units';

export interface SceneCallbacks {
  onHover(index: number): void;
  onSelect(index: number): void;
  onTextureProgress(loaded: number, total: number): void;
}

const GEO_RADIUS = GEO_RADIUS_KM / KM_PER_UNIT;

/**
 * three.js まわりの一切。React からは命令的に叩く。
 *
 * 毎フレーム 13,000 点の位置を書き換えるので、この部分を React の
 * レンダリングサイクルに乗せるのは無駄が大きい。UI は React、
 * キャンバスの中身はこのクラス、と役割を分けている。
 */
export class SceneRoot {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  readonly earth: Earth;
  readonly atmosphere: Atmosphere;
  readonly starfield: Starfield;
  readonly trails: OrbitTrails;

  field: SatelliteField | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: SceneCallbacks;
  private readonly sunDirection = new THREE.Vector3(1, 0, 0);
  private animationHandle = 0;
  private disposed = false;

  /** 直近サンプルの受信時刻(performance.now)。外挿量の計算に使う。 */
  private sampleReceivedAt = 0;
  private sampleSimTimeMs = 0;
  /** 実時間 1 秒あたりに進むシミュレーション秒数 */
  private timeScale = 1;

  private filterMask = -1;
  private thinningEnabled = true;
  private hoverIndex = -1;
  private selectedIndex = -1;
  private followSelected = false;

  private pointerNdc = new THREE.Vector2(0, 0);
  private pointerInside = false;
  private lastHoverCheck = 0;

  constructor(canvas: HTMLCanvasElement, callbacks: SceneCallbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x05070d, 1);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.camera.position.set(0, EARTH_RADIUS * 1.4, EARTH_RADIUS * 3.4);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.rotateSpeed = 0.45;
    this.controls.zoomSpeed = 0.9;
    this.controls.enablePan = false;
    // 地表に潜り込ませない / GEO の少し外まで引ける
    this.controls.minDistance = EARTH_RADIUS * 1.04;
    this.controls.maxDistance = GEO_RADIUS * 2.6;

    this.starfield = new Starfield();
    this.scene.add(this.starfield.points);

    this.earth = new Earth(new THREE.TextureLoader(), callbacks.onTextureProgress);
    this.scene.add(this.earth.mesh);

    this.atmosphere = new Atmosphere();
    this.scene.add(this.atmosphere.mesh);

    this.trails = new OrbitTrails();
    this.scene.add(this.trails.orbit.object);
    // 地上軌跡は地球と一緒に回る必要がある
    this.earth.surfaceGroup.add(this.trails.groundTrack.object);

    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerleave', this.handlePointerLeave);
    canvas.addEventListener('click', this.handleClick);
  }

  // ------------------------------------------------------------ カタログ

  setField(field: SatelliteField): void {
    if (this.field) {
      this.scene.remove(this.field.points);
      this.field.dispose();
    }
    this.field = field;
    field.setFilterMask(this.filterMask);
    this.scene.add(field.points);
  }

  /**
   * Worker から届いた新しい位置サンプル。
   * @returns 不要になった前回のバッファ(Worker へ返却して再利用させる)
   */
  applySample(
    positions: Float32Array,
    velocities: Float32Array,
    states: Uint8Array,
    simTimeMs: number,
    sun: [number, number, number],
    gmst: number,
  ): { positions: Float32Array; velocities: Float32Array; states: Uint8Array } | null {
    if (!this.field) return null;
    const recycled = this.field.setSample(positions, velocities, states);
    this.sampleReceivedAt = performance.now();
    this.sampleSimTimeMs = simTimeMs;
    this.sunDirection.set(sun[0], sun[1], sun[2]);
    this.earth.update(this.sunDirection, gmst);
    this.atmosphere.update(this.sunDirection);
    return recycled;
  }

  setTimeScale(scale: number): void {
    this.timeScale = scale;
  }

  // ------------------------------------------------------------ 表示設定

  setFilterMask(mask: number): void {
    this.filterMask = mask;
    this.field?.setFilterMask(mask);
  }

  setThinning(enabled: boolean): void {
    this.thinningEnabled = enabled;
  }

  setSelected(index: number): void {
    this.selectedIndex = index;
    this.field?.setSelected(index);
    if (index < 0) this.trails.clear();
  }

  setFollow(enabled: boolean): void {
    this.followSelected = enabled;
  }

  setTrails(points: Float32Array, groundTrack: Float32Array, groundBreaks: Int32Array): void {
    this.trails.set(points, groundTrack, groundBreaks);
  }

  setTrailVisibility(orbit: boolean, ground: boolean): void {
    this.trails.orbit.setVisible(orbit);
    this.trails.groundTrack.setVisible(ground);
  }

  /** 選択中の衛星が画面に収まる距離までカメラを寄せる */
  focusSelected(): void {
    if (!this.field || this.selectedIndex < 0) return;
    const o = this.selectedIndex * 3;
    const positions = this.field.positions;
    const x = positions[o]!;
    if (!Number.isFinite(x)) return;

    const target = new THREE.Vector3(x, positions[o + 1]!, positions[o + 2]!);
    const distance = Math.max(target.length() * 1.9, EARTH_RADIUS * 2.2);
    this.camera.position.copy(target).setLength(distance);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  // ------------------------------------------------------------ ポインタ

  private handlePointerMove = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerInside = true;
  };

  private handlePointerLeave = (): void => {
    this.pointerInside = false;
    if (this.hoverIndex !== -1) {
      this.hoverIndex = -1;
      this.callbacks.onHover(-1);
    }
  };

  private handleClick = (): void => {
    if (!this.pointerInside) return;
    const index = this.pick(14);
    this.callbacks.onSelect(index);
  };

  private pick(radiusPx: number): number {
    if (!this.field) return -1;
    const size = this.renderer.getSize(new THREE.Vector2());
    return pickSatellite({
      positions: this.field.positions,
      count: this.field.count,
      masks: this.field.masks,
      filterMask: this.filterMask,
      camera: this.camera,
      ndcX: this.pointerNdc.x,
      ndcY: this.pointerNdc.y,
      radiusPx,
      viewportWidth: size.x,
      viewportHeight: size.y,
    });
  }

  // ------------------------------------------------------------ ループ

  start(): void {
    const loop = () => {
      if (this.disposed) return;
      this.animationHandle = requestAnimationFrame(loop);
      this.frame();
    };
    this.animationHandle = requestAnimationFrame(loop);
  }

  private frame(): void {
    const now = performance.now();

    if (this.field) {
      // 直近サンプルからの経過を、時間倍率を掛けてシミュレーション秒に直す
      const elapsedRealSec = (now - this.sampleReceivedAt) / 1000;
      this.field.extrapolate(elapsedRealSec * this.timeScale);

      const size = this.renderer.getSize(new THREE.Vector2());
      this.field.updateView(
        size.y * this.renderer.getPixelRatio(),
        (this.camera.fov * Math.PI) / 180,
        this.camera.position.length(),
        this.thinningEnabled,
      );

      // ホバー判定は毎フレーム回す必要がない
      if (this.pointerInside && now - this.lastHoverCheck > 50) {
        this.lastHoverCheck = now;
        const index = this.pick(12);
        if (index !== this.hoverIndex) {
          this.hoverIndex = index;
          this.canvas.style.cursor = index >= 0 ? 'pointer' : 'grab';
          this.callbacks.onHover(index);
        }
      }

      if (this.followSelected && this.selectedIndex >= 0) this.followCamera();
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** 選択中の衛星を画面中央に保つ。カメラ距離と操作感は維持する。 */
  private followCamera(): void {
    if (!this.field) return;
    const o = this.selectedIndex * 3;
    const positions = this.field.positions;
    const x = positions[o]!;
    if (!Number.isFinite(x)) return;

    const target = new THREE.Vector3(x, positions[o + 1]!, positions[o + 2]!);
    // 注視点だけを衛星に寄せる。カメラの相対位置はユーザー操作のまま残す。
    this.controls.target.lerp(target, 0.12);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  get simTimeAtLastSample(): number {
    return this.sampleSimTimeMs;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animationHandle);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.removeEventListener('click', this.handleClick);
    this.controls.dispose();
    this.earth.dispose();
    this.atmosphere.dispose();
    this.starfield.dispose();
    this.trails.dispose();
    this.field?.dispose();
    this.renderer.dispose();
  }
}
