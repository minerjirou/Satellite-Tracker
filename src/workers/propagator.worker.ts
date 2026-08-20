/// <reference lib="webworker" />
/**
 * SGP4 伝播 Worker。
 *
 * 実測(13,000 基 / 1 時刻)では WASM の BulkPropagator が 2.85ms、純 JS ループが 5.40ms。
 * どちらも 60fps の 16.7ms 予算に収まるが、メインスレッドは描画に専念させたいので
 * 計算はすべてここで行い、位置は transferable として渡す。
 *
 * メインスレッドは受け取った位置と速度で毎フレーム外挿するため、
 * この Worker は 20Hz 程度で回れば足りる(外挿誤差は 50ms で 1cm 程度)。
 */

import {
  twoline2satrec,
  propagate,
  gstime,
  eciToGeodetic,
  eciToEcf,
  ecfToLookAngles,
  degreesLat,
  degreesLong,
  jday,
  sunPos,
  shadowFraction,
  SatRecError,
  createSingleThreadRuntime,
  BulkPropagator,
  EciBaseCalculator,
  type SatRec,
  type EciVec3,
  type AU,
} from 'satellite.js';

import { GroupIndex, type GroupsPayload } from '../data/groups';
import { EARTH_RADIUS_KM, KM_PER_UNIT, DEG, RAD, geodeticToScene } from '../lib/units';
import {
  STATE_OK,
  STATE_SUNLIT,
  type CatalogMessage,
  type FrameMessage,
  type Observer,
  type PassPrediction,
  type SatelliteDetail,
  type WorkerRequest,
} from './protocol';

const AU_TO_KM = 149597870.7;
/** 地心重力定数 (km^3/s^2) */
const MU = 398600.4418;

// ---------------------------------------------------------------- 状態

interface Catalog {
  count: number;
  satrecs: SatRec[];
  names: string[];
  line1: string[];
  line2: string[];
  ids: Int32Array;
  masks: Int32Array;
  categories: Uint8Array;
  epochMs: Float64Array;
  meanMotions: Float32Array;
  eccentricities: Float32Array;
  inclinationsDeg: Float32Array;
  intlDes: string[];
}

let catalog: Catalog | null = null;

/** WASM 一括伝播。使えなければ null のまま純 JS にフォールバックする。 */
let bulk: {
  run(date: Date): { position: Float64Array; velocity: Float64Array; error: Int8Array };
  dispose(): void;
} | null = null;

/** transferable で行き来するバッファの再利用プール */
const bufferPool: Array<{
  positions: Float32Array;
  velocities: Float32Array;
  states: Uint8Array;
}> = [];

// ---------------------------------------------------------------- TLE パース

/**
 * TLE のエポック欄 (YYDDD.DDDDDDDD) を UNIX ミリ秒に直す。
 * 2 桁年は 57 未満を 2000 年代として扱う(TLE の慣例)。
 */
function parseEpochMs(line1: string): number {
  const raw = line1.slice(18, 32).trim();
  const yy = Number.parseInt(raw.slice(0, 2), 10);
  const doy = Number.parseFloat(raw.slice(2));
  if (!Number.isFinite(yy) || !Number.isFinite(doy)) return NaN;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  // doy は 1 始まりなので 1 を引いてから加算する
  return Date.UTC(year, 0, 1) + (doy - 1) * 86400000;
}

/** Alpha-5 (100000 以上のカタログ番号を 5 桁に押し込む方式) に対応した番号読み取り */
const ALPHA5 = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function parseCatalogNumber(field: string): number {
  const s = field.trim();
  if (!s) return NaN;
  const idx = ALPHA5.indexOf(s[0]!.toUpperCase());
  if (idx === -1) return Number.parseInt(s, 10);
  const rest = Number.parseInt(s.slice(1), 10);
  return Number.isNaN(rest) ? NaN : (idx + 10) * 10000 + rest;
}

/** NORAD ID から 0-1 の決まった値を作る。間引きに使うので、実行のたびに変わってはいけない。 */
function thinKeyFor(id: number): number {
  // xorshift 風の簡単な撹拌。近い ID が近い値にならなければよい。
  let x = (id * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 8) / 16777216;
}

interface ParseResult {
  catalog: Catalog;
  skipped: number;
  ungrouped: number;
}

function parseTle(text: string, groups: GroupIndex): ParseResult {
  const lines = text.split('\n');
  const satrecs: SatRec[] = [];
  const names: string[] = [];
  const line1: string[] = [];
  const line2: string[] = [];
  const intlDes: string[] = [];
  const idList: number[] = [];
  const maskList: number[] = [];
  const categoryList: number[] = [];
  const epochList: number[] = [];
  const meanMotionList: number[] = [];
  const eccList: number[] = [];
  const incList: number[] = [];

  let skipped = 0;
  let ungrouped = 0;
  let pendingName = '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.replace(/\r$/, '');
    if (line.length === 0) continue;

    if (line[0] === '1' && line[1] === ' ') {
      const next = lines[i + 1]?.replace(/\r$/, '') ?? '';
      if (next[0] !== '2' || next[1] !== ' ') {
        skipped += 1;
        continue;
      }
      i += 1;

      let satrec: SatRec;
      try {
        satrec = twoline2satrec(line, next);
      } catch {
        skipped += 1;
        pendingName = '';
        continue;
      }

      const id = parseCatalogNumber(line.slice(2, 7));
      if (!Number.isFinite(id)) {
        skipped += 1;
        pendingName = '';
        continue;
      }

      const meanMotion = Number.parseFloat(next.slice(52, 63));
      const ecc = Number.parseFloat(`0.${next.slice(26, 33).trim()}`);
      const inc = Number.parseFloat(next.slice(8, 16));
      const mask = groups.maskFor(id);
      if (groups.isUngrouped(mask)) ungrouped += 1;

      satrecs.push(satrec);
      names.push(pendingName || `NORAD ${id}`);
      line1.push(line);
      line2.push(next);
      intlDes.push(formatIntlDes(line.slice(9, 17)));
      idList.push(id);
      maskList.push(mask);
      categoryList.push(groups.categoryFor(mask, meanMotion, ecc));
      epochList.push(parseEpochMs(line));
      meanMotionList.push(meanMotion);
      eccList.push(ecc);
      incList.push(inc);
      pendingName = '';
    } else if (line[0] !== '2') {
      // 名前行。CelesTrak は素の名前を出すが、"0 NAME" 形式の 3LE も受け付ける。
      pendingName = line.startsWith('0 ') ? line.slice(2).trim() : line.trim();
    }
  }

  const count = satrecs.length;
  return {
    skipped,
    ungrouped,
    catalog: {
      count,
      satrecs,
      names,
      line1,
      line2,
      intlDes,
      ids: Int32Array.from(idList),
      masks: Int32Array.from(maskList),
      categories: Uint8Array.from(categoryList),
      epochMs: Float64Array.from(epochList),
      meanMotions: Float32Array.from(meanMotionList),
      eccentricities: Float32Array.from(eccList),
      inclinationsDeg: Float32Array.from(incList),
    },
  };
}

/** "98067A  " → "1998-067A" */
function formatIntlDes(field: string): string {
  const s = field.trim();
  if (s.length < 5) return s;
  const yy = Number.parseInt(s.slice(0, 2), 10);
  if (!Number.isFinite(yy)) return s;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return `${year}-${s.slice(2)}`;
}

// ---------------------------------------------------------------- WASM 初期化

async function initBulkPropagator(satrecs: SatRec[]): Promise<boolean> {
  try {
    const runtime = await createSingleThreadRuntime();
    const propagator = new BulkPropagator({
      runtime,
      calculators: [new EciBaseCalculator()],
      satRecsCount: satrecs.length,
      datesCount: 1,
    });
    propagator.setSatRecs(satrecs);

    const dates: Date[] = [new Date()];
    bulk = {
      run(date) {
        dates[0] = date;
        propagator.setDates(dates);
        propagator.run({ eci: { communityDecayCheckEnabled: true } });
        return propagator.getRawOutput().eci;
      },
      dispose() {
        propagator.dispose();
        runtime.dispose();
      },
    };
    return true;
  } catch (err) {
    console.warn('WASM 伝播を初期化できませんでした — 純 JS にフォールバックします', err);
    bulk = null;
    return false;
  }
}

// ---------------------------------------------------------------- フレーム計算

function takeBuffers(count: number) {
  const pooled = bufferPool.pop();
  if (pooled && pooled.states.length === count) return pooled;
  return {
    positions: new Float32Array(count * 3),
    velocities: new Float32Array(count * 3),
    states: new Uint8Array(count),
  };
}

/**
 * 円柱影による日照判定。
 * 半影まで厳密に見る shadowFraction は選択中の 1 基だけに使い、
 * 全 13,000 基にはこの軽い判定を使う(見た目には十分)。
 */
function isSunlit(x: number, y: number, z: number, sx: number, sy: number, sz: number): boolean {
  const proj = x * sx + y * sy + z * sz;
  if (proj > 0) return true; // 太陽側にいる
  const px = x - proj * sx;
  const py = y - proj * sy;
  const pz = z - proj * sz;
  return Math.hypot(px, py, pz) > EARTH_RADIUS_KM;
}

function computeFrame(simTimeMs: number): FrameMessage | null {
  if (!catalog) return null;
  const { count, satrecs } = catalog;
  const date = new Date(simTimeMs);

  const { positions, velocities, states } = takeBuffers(count);

  // 太陽方向(ECI 単位ベクトル)
  const sun = sunPos(jday(date)).rsun;
  const sunLen = Math.hypot(sun.x, sun.y, sun.z) || 1;
  const sx = sun.x / sunLen;
  const sy = sun.y / sunLen;
  const sz = sun.z / sunLen;

  if (bulk) {
    const raw = bulk.run(date);
    const pos = raw.position;
    const vel = raw.velocity;
    const err = raw.error;
    for (let i = 0; i < count; i += 1) {
      const o = i * 3;
      if (err[i] !== SatRecError.None) {
        states[i] = 0;
        continue;
      }
      const x = pos[o]!;
      const y = pos[o + 1]!;
      const z = pos[o + 2]!;
      if (!Number.isFinite(x)) {
        states[i] = 0;
        continue;
      }
      // ECI(z が北) → three.js(y が北)
      positions[o] = x / KM_PER_UNIT;
      positions[o + 1] = z / KM_PER_UNIT;
      positions[o + 2] = -y / KM_PER_UNIT;
      velocities[o] = vel[o]! / KM_PER_UNIT;
      velocities[o + 1] = vel[o + 2]! / KM_PER_UNIT;
      velocities[o + 2] = -vel[o + 1]! / KM_PER_UNIT;
      states[i] = STATE_OK | (isSunlit(x, y, z, sx, sy, sz) ? STATE_SUNLIT : 0);
    }
  } else {
    for (let i = 0; i < count; i += 1) {
      const o = i * 3;
      let pv: ReturnType<typeof propagate>;
      try {
        pv = propagate(satrecs[i]!, date, { communityDecayCheckEnabled: true });
      } catch {
        states[i] = 0;
        continue;
      }
      if (!pv || !Number.isFinite(pv.position.x)) {
        states[i] = 0;
        continue;
      }
      const { x, y, z } = pv.position;
      positions[o] = x / KM_PER_UNIT;
      positions[o + 1] = z / KM_PER_UNIT;
      positions[o + 2] = -y / KM_PER_UNIT;
      velocities[o] = pv.velocity.x / KM_PER_UNIT;
      velocities[o + 1] = pv.velocity.z / KM_PER_UNIT;
      velocities[o + 2] = -pv.velocity.y / KM_PER_UNIT;
      states[i] = STATE_OK | (isSunlit(x, y, z, sx, sy, sz) ? STATE_SUNLIT : 0);
    }
  }

  return {
    type: 'frame',
    simTimeMs,
    positions,
    velocities,
    states,
    // 太陽方向もシーン座標へ揃える
    sun: [sx, sz, -sy],
    gmst: gstime(date),
  };
}

// ---------------------------------------------------------------- 詳細 / 軌道 / パス

function orbitPeriodMinutes(meanMotion: number): number {
  return meanMotion > 0 ? 1440 / meanMotion : 0;
}

function semiMajorAxisKm(meanMotionRevPerDay: number): number {
  const n = (meanMotionRevPerDay * 2 * Math.PI) / 86400; // rad/s
  return n > 0 ? Math.cbrt(MU / (n * n)) : NaN;
}

function computeDetail(index: number, simTimeMs: number): SatelliteDetail | null {
  if (!catalog || index < 0 || index >= catalog.count) return null;
  const date = new Date(simTimeMs);
  const satrec = catalog.satrecs[index]!;

  let pv: ReturnType<typeof propagate> = null;
  try {
    pv = propagate(satrec, date, { communityDecayCheckEnabled: true });
  } catch {
    pv = null;
  }

  const meanMotion = catalog.meanMotions[index]!;
  const ecc = catalog.eccentricities[index]!;
  const a = semiMajorAxisKm(meanMotion);

  const base = {
    index,
    noradId: catalog.ids[index]!,
    name: catalog.names[index]!,
    intlDes: catalog.intlDes[index]!,
    mask: catalog.masks[index]!,
    category: catalog.categories[index]!,
    epochMs: catalog.epochMs[index]!,
    inclinationDeg: catalog.inclinationsDeg[index]!,
    eccentricity: ecc,
    periodMinutes: orbitPeriodMinutes(meanMotion),
    apogeeKm: a * (1 + ecc) - EARTH_RADIUS_KM,
    perigeeKm: a * (1 - ecc) - EARTH_RADIUS_KM,
    tleLine1: catalog.line1[index]!,
    tleLine2: catalog.line2[index]!,
  };

  if (!pv) {
    return {
      ...base,
      altitudeKm: NaN,
      speedKmPerSec: NaN,
      latitudeDeg: NaN,
      longitudeDeg: NaN,
      shadowFraction: NaN,
      error: satrec.error,
    };
  }

  const gd = eciToGeodetic(pv.position, gstime(date));
  const sun = sunPos(jday(date)).rsun;

  return {
    ...base,
    altitudeKm: gd.height,
    speedKmPerSec: Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z),
    latitudeDeg: degreesLat(gd.latitude),
    longitudeDeg: degreesLong(gd.longitude),
    shadowFraction: shadowFraction(sun, pv.position),
    error: SatRecError.None,
  };
}

const ORBIT_SAMPLES = 512;

/**
 * 軌道 1 周分と、その地上軌跡を作る。
 *
 * 地上軌跡は経度が ±180° をまたぐところで線分を切らないと、
 * 地球の裏側を突っ切る直線が描かれてしまう。
 */
function computeOrbit(index: number, simTimeMs: number) {
  if (!catalog || index < 0 || index >= catalog.count) return null;
  const satrec = catalog.satrecs[index]!;
  const periodMin = orbitPeriodMinutes(catalog.meanMotions[index]!);
  if (!Number.isFinite(periodMin) || periodMin <= 0) return null;

  const points = new Float32Array(ORBIT_SAMPLES * 3);
  const ground = new Float32Array(ORBIT_SAMPLES * 3);
  const breaks: number[] = [0];

  const stepMs = (periodMin * 60000) / (ORBIT_SAMPLES - 1);
  const groundRadius = (EARTH_RADIUS_KM + 60) / KM_PER_UNIT;
  const scratch = { x: 0, y: 0, z: 0 };
  let previousLon = Number.NaN;

  for (let s = 0; s < ORBIT_SAMPLES; s += 1) {
    const date = new Date(simTimeMs + s * stepMs);
    let pv: ReturnType<typeof propagate> = null;
    try {
      pv = propagate(satrec, date, { communityDecayCheckEnabled: true });
    } catch {
      pv = null;
    }
    const o = s * 3;
    if (!pv || !Number.isFinite(pv.position.x)) {
      points[o] = Number.NaN;
      ground[o] = Number.NaN;
      continue;
    }

    points[o] = pv.position.x / KM_PER_UNIT;
    points[o + 1] = pv.position.z / KM_PER_UNIT;
    points[o + 2] = -pv.position.y / KM_PER_UNIT;

    const gd = eciToGeodetic(pv.position, gstime(date));
    geodeticToScene(gd.latitude, gd.longitude, groundRadius, scratch);
    ground[o] = scratch.x;
    ground[o + 1] = scratch.y;
    ground[o + 2] = scratch.z;

    // 日付変更線をまたいだら線分を切る
    if (Number.isFinite(previousLon) && Math.abs(gd.longitude - previousLon) > Math.PI) {
      breaks.push(s);
    }
    previousLon = gd.longitude;
  }

  return {
    points,
    groundTrack: ground,
    groundBreaks: Int32Array.from(breaks),
  };
}

/** 太陽の見かけの仰角(度)。負が大きいほど空が暗い。 */
function sunElevationDeg(observerGd: { latitude: number; longitude: number; height: number }, date: Date): number {
  const sun = sunPos(jday(date)).rsun;
  const sunKm: EciVec3<number> = {
    x: sun.x * AU_TO_KM,
    y: sun.y * AU_TO_KM,
    z: sun.z * AU_TO_KM,
  };
  const ecf = eciToEcf(sunKm, gstime(date));
  return ecfToLookAngles(observerGd, ecf).elevation * RAD;
}

const PASS_HORIZON_DEG = 10;
const PASS_WINDOW_HOURS = 48;
const PASS_STEP_SEC = 30;

function computePasses(index: number, simTimeMs: number, observer: Observer): PassPrediction[] {
  if (!catalog || index < 0 || index >= catalog.count) return [];
  const satrec = catalog.satrecs[index]!;
  const observerGd = {
    latitude: observer.latitudeDeg * DEG,
    longitude: observer.longitudeDeg * DEG,
    height: observer.altitudeKm,
  };

  const elevationAt = (ms: number): number => {
    const date = new Date(ms);
    try {
      const pv = propagate(satrec, date, { communityDecayCheckEnabled: true });
      if (!pv || !Number.isFinite(pv.position.x)) return Number.NaN;
      const ecf = eciToEcf(pv.position, gstime(date));
      return ecfToLookAngles(observerGd, ecf).elevation * RAD;
    } catch {
      return Number.NaN;
    }
  };

  const azimuthAt = (ms: number): number => {
    const date = new Date(ms);
    try {
      const pv = propagate(satrec, date, { communityDecayCheckEnabled: true });
      if (!pv || !Number.isFinite(pv.position.x)) return Number.NaN;
      const ecf = eciToEcf(pv.position, gstime(date));
      return ((ecfToLookAngles(observerGd, ecf).azimuth * RAD) % 360 + 360) % 360;
    } catch {
      return Number.NaN;
    }
  };

  /** 地平線通過時刻を二分法で 1 秒まで詰める */
  const refineCrossing = (belowMs: number, aboveMs: number): number => {
    let lo = belowMs;
    let hi = aboveMs;
    for (let i = 0; i < 12 && Math.abs(hi - lo) > 1000; i += 1) {
      const mid = (lo + hi) / 2;
      if (elevationAt(mid) > 0) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };

  const passes: PassPrediction[] = [];
  const endMs = simTimeMs + PASS_WINDOW_HOURS * 3600_000;
  const stepMs = PASS_STEP_SEC * 1000;

  let previousMs = simTimeMs;
  let previousEl = elevationAt(simTimeMs);
  let enterMs = previousEl > 0 ? simTimeMs : NaN;
  let peakMs = simTimeMs;
  let peakEl = previousEl > 0 ? previousEl : -90;

  for (let ms = simTimeMs + stepMs; ms <= endMs; ms += stepMs) {
    const el = elevationAt(ms);
    if (!Number.isFinite(el)) break;

    if (el > 0 && previousEl <= 0) {
      enterMs = refineCrossing(previousMs, ms);
      peakMs = ms;
      peakEl = el;
    } else if (el > 0) {
      if (el > peakEl) {
        peakEl = el;
        peakMs = ms;
      }
    } else if (previousEl > 0 && Number.isFinite(enterMs)) {
      const exitMs = refineCrossing(ms, previousMs);
      if (peakEl >= PASS_HORIZON_DEG) {
        // 最大仰角の時刻を 3 点内挿でもう少し詰める
        const refinedPeak = refinePeak(elevationAt, peakMs, stepMs);
        const satLit = isSatelliteSunlit(satrec, refinedPeak.ms);
        const skyDark = sunElevationDeg(observerGd, new Date(refinedPeak.ms)) < -6;
        passes.push({
          startMs: enterMs,
          endMs: exitMs,
          peakMs: refinedPeak.ms,
          maxElevationDeg: refinedPeak.elevation,
          startAzimuthDeg: azimuthAt(enterMs),
          peakAzimuthDeg: azimuthAt(refinedPeak.ms),
          endAzimuthDeg: azimuthAt(exitMs),
          visible: satLit && skyDark,
        });
      }
      enterMs = NaN;
      peakEl = -90;
    }

    previousEl = el;
    previousMs = ms;
    if (passes.length >= 60) break;
  }

  return passes;
}

/** 黄金分割で最大仰角の時刻を詰める */
function refinePeak(
  elevationAt: (ms: number) => number,
  aroundMs: number,
  stepMs: number,
): { ms: number; elevation: number } {
  let lo = aroundMs - stepMs;
  let hi = aroundMs + stepMs;
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = hi - phi * (hi - lo);
  let d = lo + phi * (hi - lo);
  let fc = elevationAt(c);
  let fd = elevationAt(d);
  for (let i = 0; i < 20 && hi - lo > 500; i += 1) {
    if (fc > fd) {
      hi = d;
      d = c;
      fd = fc;
      c = hi - phi * (hi - lo);
      fc = elevationAt(c);
    } else {
      lo = c;
      c = d;
      fc = fd;
      d = lo + phi * (hi - lo);
      fd = elevationAt(d);
    }
  }
  const ms = (lo + hi) / 2;
  return { ms, elevation: elevationAt(ms) };
}

function isSatelliteSunlit(satrec: SatRec, ms: number): boolean {
  const date = new Date(ms);
  try {
    const pv = propagate(satrec, date, { communityDecayCheckEnabled: true });
    if (!pv || !Number.isFinite(pv.position.x)) return false;
    const sun: EciVec3<AU> = sunPos(jday(date)).rsun;
    return shadowFraction(sun, pv.position) < 0.5;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- メッセージ処理

const ctx = self as unknown as DedicatedWorkerGlobalScope;

async function handleInit(tle: string, groupsPayload: GroupsPayload | null) {
  const groups = new GroupIndex(groupsPayload);
  const parsed = parseTle(tle, groups);

  if (parsed.catalog.count === 0) {
    ctx.postMessage({
      type: 'error',
      message: '軌道要素を 1 件も読み取れませんでした。データ形式が想定と違う可能性があります。',
    });
    return;
  }

  bulk?.dispose();
  bulk = null;
  catalog = parsed.catalog;

  const usingWasm = await initBulkPropagator(parsed.catalog.satrecs);

  const thinKeys = new Float32Array(parsed.catalog.count);
  for (let i = 0; i < parsed.catalog.count; i += 1) {
    thinKeys[i] = thinKeyFor(parsed.catalog.ids[i]!);
  }

  const message: CatalogMessage = {
    type: 'catalog',
    count: parsed.catalog.count,
    names: parsed.catalog.names,
    ids: parsed.catalog.ids,
    masks: parsed.catalog.masks,
    categories: parsed.catalog.categories,
    thinKeys,
    epochMs: parsed.catalog.epochMs,
    meanMotions: parsed.catalog.meanMotions,
    eccentricities: parsed.catalog.eccentricities,
    inclinationsDeg: parsed.catalog.inclinationsDeg,
    intlDes: parsed.catalog.intlDes,
    ungroupedCount: parsed.ungrouped,
    usingWasm,
    skipped: parsed.skipped,
  };
  ctx.postMessage(message);
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'init':
        void handleInit(msg.tle, msg.groups);
        break;

      case 'tick': {
        const frame = computeFrame(msg.simTimeMs);
        if (frame) {
          ctx.postMessage(frame, [
            frame.positions.buffer,
            frame.velocities.buffer,
            frame.states.buffer,
          ]);
        }
        break;
      }

      case 'release':
        bufferPool.push({
          positions: new Float32Array(msg.positions),
          velocities: new Float32Array(msg.velocities),
          states: new Uint8Array(msg.states),
        });
        // 溜め込みすぎない
        if (bufferPool.length > 3) bufferPool.length = 3;
        break;

      case 'detail':
        ctx.postMessage({ type: 'detail', detail: computeDetail(msg.index, msg.simTimeMs) });
        break;

      case 'orbit': {
        const result = computeOrbit(msg.index, msg.simTimeMs);
        if (result) {
          ctx.postMessage(
            {
              type: 'orbit',
              index: msg.index,
              points: result.points,
              groundTrack: result.groundTrack,
              groundBreaks: result.groundBreaks,
            },
            [result.points.buffer, result.groundTrack.buffer, result.groundBreaks.buffer],
          );
        }
        break;
      }

      case 'passes':
        ctx.postMessage({
          type: 'passes',
          index: msg.index,
          passes: computePasses(msg.index, msg.simTimeMs, msg.observer),
        });
        break;
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', message: `伝播 Worker でエラーが発生しました: ${String(err)}` });
  }
};
