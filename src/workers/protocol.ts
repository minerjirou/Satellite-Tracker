/**
 * メインスレッドと伝播 Worker のあいだのメッセージ定義。
 *
 * 位置バッファは transferable として渡し、使い終わったらメインスレッドが
 * Worker へ返却する(ping-pong)。13,000 基 × 3 成分 × 2 種類 = 約 312KB を
 * 20Hz でやり取りするので、コピーもアロケーションも避けたい。
 */

import type { GroupsPayload } from '../data/groups';

/** 観測地点(可視パス予測用) */
export interface Observer {
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeKm: number;
}

// ---------------------------------------------------------------- main → worker

export interface InitMessage {
  type: 'init';
  tle: string;
  groups: GroupsPayload | null;
}

/** この時刻の位置を計算してほしい、という要求 */
export interface TickMessage {
  type: 'tick';
  simTimeMs: number;
}

/** 使い終わった位置バッファの返却 */
export interface ReleaseMessage {
  type: 'release';
  positions: ArrayBuffer;
  velocities: ArrayBuffer;
  states: ArrayBuffer;
}

export interface DetailMessage {
  type: 'detail';
  index: number;
  simTimeMs: number;
}

export interface OrbitMessage {
  type: 'orbit';
  index: number;
  simTimeMs: number;
}

export interface PassesMessage {
  type: 'passes';
  index: number;
  simTimeMs: number;
  observer: Observer;
}

export type WorkerRequest =
  | InitMessage
  | TickMessage
  | ReleaseMessage
  | DetailMessage
  | OrbitMessage
  | PassesMessage;

// ---------------------------------------------------------------- worker → main

/**
 * 起動時に一度だけ送られる衛星カタログ。
 * 名前以外は TypedArray なので、13,000 件でも転送は一瞬で済む。
 */
export interface CatalogMessage {
  type: 'catalog';
  count: number;
  names: string[];
  ids: Int32Array;
  /** CelesTrak グループ所属のビットマスク */
  masks: Int32Array;
  /** 表示カテゴリ(Category) */
  categories: Uint8Array;
  /** 間引き判定用の 0-1 の擬似乱数。同じ衛星は常に同じ値になる。 */
  thinKeys: Float32Array;
  /** TLE のエポック(ミリ秒)。古すぎる要素の警告に使う。 */
  epochMs: Float64Array;
  /** 1 日あたりの周回数 */
  meanMotions: Float32Array;
  eccentricities: Float32Array;
  inclinationsDeg: Float32Array;
  /** 国際識別符号 (例 1998-067A) */
  intlDes: string[];
  /** groups.json が無くて軌道形状から分類した件数 */
  ungroupedCount: number;
  /** WASM 伝播が使えたか(使えなければ純 JS にフォールバックしている) */
  usingWasm: boolean;
  /** パースできなかった行の数 */
  skipped: number;
}

/** ビット単位の状態フラグ(states 配列の各要素) */
export const STATE_OK = 1;
export const STATE_SUNLIT = 2;

export interface FrameMessage {
  type: 'frame';
  simTimeMs: number;
  /** シーン単位(1 = 1000km)の位置 [x,y,z] × N */
  positions: Float32Array;
  /** シーン単位/秒 の速度。メインスレッドはこれで frame 間を外挿する。 */
  velocities: Float32Array;
  /** STATE_* のビットフラグ */
  states: Uint8Array;
  /** 太陽方向の単位ベクトル(シーン座標) */
  sun: [number, number, number];
  /** グリニッジ平均恒星時(ラジアン)。地球メッシュの自転角。 */
  gmst: number;
}

export interface SatelliteDetail {
  index: number;
  noradId: number;
  name: string;
  intlDes: string;
  mask: number;
  category: number;
  epochMs: number;
  altitudeKm: number;
  speedKmPerSec: number;
  latitudeDeg: number;
  longitudeDeg: number;
  inclinationDeg: number;
  eccentricity: number;
  periodMinutes: number;
  apogeeKm: number;
  perigeeKm: number;
  /** 0 = 完全に日照、1 = 本影。0.x は半影。 */
  shadowFraction: number;
  tleLine1: string;
  tleLine2: string;
  error: number;
}

export interface DetailResultMessage {
  type: 'detail';
  detail: SatelliteDetail | null;
}

export interface OrbitResultMessage {
  type: 'orbit';
  index: number;
  /** シーン単位の軌道 1 周分(ECI) */
  points: Float32Array;
  /** 地上軌跡。経度が ±180° をまたぐ位置で切れ目が入る。 */
  groundTrack: Float32Array;
  /** groundTrack のうち、ここから新しい線分が始まるという添字 */
  groundBreaks: Int32Array;
}

export interface PassPrediction {
  startMs: number;
  endMs: number;
  peakMs: number;
  maxElevationDeg: number;
  startAzimuthDeg: number;
  peakAzimuthDeg: number;
  endAzimuthDeg: number;
  /** 観測地が暗く、衛星が日照中 = 肉眼で見える見込み */
  visible: boolean;
}

export interface PassesResultMessage {
  type: 'passes';
  index: number;
  passes: PassPrediction[];
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type WorkerResponse =
  | CatalogMessage
  | FrameMessage
  | DetailResultMessage
  | OrbitResultMessage
  | PassesResultMessage
  | ErrorMessage;
