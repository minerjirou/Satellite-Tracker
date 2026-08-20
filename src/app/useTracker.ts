import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchGroups, fetchMeta, fetchTle, type CatalogMeta } from '../data/api';
import { GroupIndex, type GroupsPayload } from '../data/groups';
import { SatelliteField } from '../scene/SatelliteField';
import { SceneRoot } from '../scene/SceneRoot';
import { SimClock } from '../lib/clock';
import type {
  CatalogMessage,
  Observer,
  PassPrediction,
  SatelliteDetail,
  WorkerResponse,
} from '../workers/protocol';

/** 位置サンプルの要求間隔。速度で外挿するので 20Hz あれば 60fps で滑らかに見える。 */
const TICK_INTERVAL_MS = 50;
/** 選択中の衛星の数値を更新する間隔 */
const DETAIL_INTERVAL_MS = 400;
/** 国際宇宙ステーション。起動時にここへ寄る。 */
const ISS_NORAD_ID = 25544;

export type Phase = 'loading' | 'ready' | 'error';

export interface LoadStatus {
  phase: Phase;
  message: string;
  error?: string;
}

export interface CatalogInfo {
  count: number;
  ungroupedCount: number;
  usingWasm: boolean;
  skipped: number;
  groupNames: string[];
  /** CelesTrak から実際にグループ情報を取得できたか */
  hasGroups: boolean;
  /** グループ名 → 所属衛星数 */
  groupCounts: Record<string, number>;
  fetchedAt: string | null;
  groupsFetchedAt: string | null;
}

export interface SearchHit {
  index: number;
  noradId: number;
  name: string;
}

export interface TrackerApi {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  status: LoadStatus;
  catalog: CatalogInfo | null;
  meta: CatalogMeta | null;

  selectedIndex: number;
  detail: SatelliteDetail | null;
  hoverName: string | null;
  select(index: number): void;
  selectByNoradId(id: number): boolean;
  focusSelected(): void;

  filterMask: number;
  toggleGroup(name: string): void;
  setAllGroups(enabled: boolean): void;
  isGroupEnabled(name: string): boolean;

  search(query: string): SearchHit[];

  simTimeMs: number;
  rate: number;
  paused: boolean;
  offsetHours: number;
  setRate(rate: number): void;
  togglePaused(): void;
  setOffsetHours(hours: number): void;
  resetToNow(): void;

  follow: boolean;
  setFollow(value: boolean): void;
  showOrbit: boolean;
  setShowOrbit(value: boolean): void;
  showGround: boolean;
  setShowGround(value: boolean): void;
  thinning: boolean;
  setThinning(value: boolean): void;

  observer: Observer | null;
  passes: PassPrediction[] | null;
  passesBusy: boolean;
  passesError: string | null;
  useCurrentLocation(): void;
  setManualObserver(latDeg: number, lonDeg: number): void;
  requestPasses(): void;
}

export function useTracker(): TrackerApi {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<SceneRoot | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const clockRef = useRef<SimClock>(new SimClock());
  const catalogRef = useRef<CatalogMessage | null>(null);
  /** 検索用に大文字化した名前。キー入力のたびに 13,000 件を変換し直さないよう一度だけ作る。 */
  const namesUpperRef = useRef<string[]>([]);
  const groupIndexRef = useRef<GroupIndex | null>(null);
  const selectedRef = useRef(-1);
  const tickTimerRef = useRef<number | null>(null);
  const lastDetailRef = useRef(0);
  const observerRef = useRef<Observer | null>(null);

  const [status, setStatus] = useState<LoadStatus>({
    phase: 'loading',
    message: '起動しています…',
  });
  const [catalog, setCatalog] = useState<CatalogInfo | null>(null);
  const [meta, setMeta] = useState<CatalogMeta | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [detail, setDetail] = useState<SatelliteDetail | null>(null);
  const [hoverName, setHoverName] = useState<string | null>(null);
  const [filterMask, setFilterMaskState] = useState(-1);
  const [simTimeMs, setSimTimeMs] = useState(() => Date.now());
  const [rate, setRateState] = useState(1);
  const [paused, setPaused] = useState(false);
  const [offsetHours, setOffsetHoursState] = useState(0);
  const [follow, setFollowState] = useState(false);
  const [showOrbit, setShowOrbitState] = useState(true);
  const [showGround, setShowGroundState] = useState(true);
  const [thinning, setThinningState] = useState(true);
  const [observer, setObserver] = useState<Observer | null>(null);
  const [passes, setPasses] = useState<PassPrediction[] | null>(null);
  const [passesBusy, setPassesBusy] = useState(false);
  const [passesError, setPassesError] = useState<string | null>(null);

  // ------------------------------------------------------------ Worker への要求

  const requestTick = useCallback(() => {
    workerRef.current?.postMessage({ type: 'tick', simTimeMs: clockRef.current.now() });
  }, []);

  const requestOrbit = useCallback((index: number) => {
    if (index < 0) return;
    workerRef.current?.postMessage({
      type: 'orbit',
      index,
      simTimeMs: clockRef.current.now(),
    });
  }, []);

  const requestDetail = useCallback((index: number) => {
    if (index < 0) return;
    workerRef.current?.postMessage({
      type: 'detail',
      index,
      simTimeMs: clockRef.current.now(),
    });
  }, []);

  // ------------------------------------------------------------ 選択

  const select = useCallback(
    (index: number) => {
      selectedRef.current = index;
      setSelectedIndex(index);
      sceneRef.current?.setSelected(index);
      if (index < 0) {
        setDetail(null);
        setPasses(null);
        return;
      }
      requestDetail(index);
      requestOrbit(index);
      setPasses(null);
      setPassesError(null);
    },
    [requestDetail, requestOrbit],
  );

  const selectByNoradId = useCallback(
    (id: number): boolean => {
      const cat = catalogRef.current;
      if (!cat) return false;
      const index = cat.ids.indexOf(id);
      if (index === -1) return false;
      select(index);
      return true;
    },
    [select],
  );

  // ------------------------------------------------------------ 初期化

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scene = new SceneRoot(canvas, {
      onHover: (index) => {
        const cat = catalogRef.current;
        setHoverName(index >= 0 && cat ? (cat.names[index] ?? null) : null);
      },
      onSelect: (index) => {
        // 何もない場所のクリックで選択解除はしない(操作ミスで詳細が消えると煩わしい)
        if (index >= 0) select(index);
      },
      onTextureProgress: (loaded, total) => {
        if (loaded < total) setStatus((s) => (s.phase === 'loading' ? { ...s, message: '地球のテクスチャを読み込んでいます…' } : s));
      },
    });
    sceneRef.current = scene;
    scene.start();

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      scene.resize(Math.max(rect.width, 1), Math.max(rect.height, 1));
    };
    resize();
    const observerRo = new ResizeObserver(resize);
    observerRo.observe(canvas);

    return () => {
      observerRo.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, [select]);

  // データ取得 → Worker 起動
  useEffect(() => {
    const abort = new AbortController();
    let worker: Worker | null = null;

    const run = async () => {
      try {
        setStatus({ phase: 'loading', message: 'CelesTrak の軌道要素を取得しています…' });

        let groups: GroupsPayload | null = null;
        let tle: { text: string; fetchedAt: string | null };
        try {
          [groups, tle] = await Promise.all([
            fetchGroups(abort.signal),
            fetchTle(abort.signal),
          ]);
        } catch (err) {
          if (abort.signal.aborted) return;
          throw err;
        }

        void fetchMeta(abort.signal).then((m) => {
          if (!abort.signal.aborted) setMeta(m);
        });

        setStatus({ phase: 'loading', message: '軌道要素を解析しています…' });
        groupIndexRef.current = new GroupIndex(groups);

        worker = new Worker(new URL('../workers/propagator.worker.ts', import.meta.url), {
          type: 'module',
        });
        workerRef.current = worker;
        worker.onmessage = (event: MessageEvent<WorkerResponse>) =>
          handleWorkerMessage(event.data, tle.fetchedAt);
        worker.onerror = (event) => {
          setStatus({
            phase: 'error',
            message: '計算スレッドの起動に失敗しました',
            error: event.message,
          });
        };
        worker.postMessage({ type: 'init', tle: tle.text, groups });
      } catch (err) {
        if (abort.signal.aborted) return;
        setStatus({
          phase: 'error',
          message: 'データを読み込めませんでした',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const handleWorkerMessage = (msg: WorkerResponse, tleFetchedAt: string | null) => {
      const scene = sceneRef.current;

      switch (msg.type) {
        case 'catalog': {
          catalogRef.current = msg;
          namesUpperRef.current = msg.names.map((n) => n.toUpperCase());
          const groupIndex = groupIndexRef.current ?? new GroupIndex(null);

          const field = new SatelliteField(
            msg.count,
            msg.categories,
            msg.masks,
            msg.thinKeys,
            groupIndex.thinnableMask,
          );
          scene?.setField(field);

          const allMask = groupIndex.allMask;
          setFilterMaskState(allMask);
          scene?.setFilterMask(allMask);

          const groupCounts: Record<string, number> = {};
          groupIndex.names.forEach((name, bit) => {
            const flag = 1 << bit;
            let count = 0;
            for (let i = 0; i < msg.count; i += 1) if (msg.masks[i]! & flag) count += 1;
            groupCounts[name] = count;
          });

          setCatalog({
            count: msg.count,
            ungroupedCount: msg.ungroupedCount,
            usingWasm: msg.usingWasm,
            skipped: msg.skipped,
            groupNames: groupIndex.names,
            hasGroups: groupIndex.hasGroups,
            groupCounts,
            fetchedAt: tleFetchedAt,
            groupsFetchedAt: groupIndex.fetchedAt,
          });

          setStatus({ phase: 'ready', message: '' });
          requestTick();

          // 起動直後は ISS を見せる。何を見ているのか一目で伝わる。
          const issIndex = msg.ids.indexOf(ISS_NORAD_ID);
          if (issIndex >= 0) {
            select(issIndex);
            // 最初のフレームが届いて位置が確定してから寄せる
            window.setTimeout(() => sceneRef.current?.focusSelected(), 250);
          }
          break;
        }

        case 'frame': {
          const recycled = scene?.applySample(
            msg.positions,
            msg.velocities,
            msg.states,
            msg.simTimeMs,
            msg.sun,
            msg.gmst,
          );
          scene?.setTimeScale(clockRef.current.effectiveScale);

          if (recycled && workerRef.current) {
            workerRef.current.postMessage(
              {
                type: 'release',
                positions: recycled.positions.buffer,
                velocities: recycled.velocities.buffer,
                states: recycled.states.buffer,
              },
              [recycled.positions.buffer, recycled.velocities.buffer, recycled.states.buffer],
            );
          }

          setSimTimeMs(msg.simTimeMs);

          const now = performance.now();
          if (selectedRef.current >= 0 && now - lastDetailRef.current > DETAIL_INTERVAL_MS) {
            lastDetailRef.current = now;
            requestDetail(selectedRef.current);
          }

          tickTimerRef.current = window.setTimeout(requestTick, TICK_INTERVAL_MS);
          break;
        }

        case 'detail':
          setDetail(msg.detail);
          break;

        case 'orbit':
          if (msg.index === selectedRef.current) {
            scene?.setTrails(msg.points, msg.groundTrack, msg.groundBreaks);
          }
          break;

        case 'passes':
          setPassesBusy(false);
          setPasses(msg.passes);
          break;

        case 'error':
          setStatus({ phase: 'error', message: '計算中にエラーが発生しました', error: msg.message });
          break;
      }
    };

    void run();

    return () => {
      abort.abort();
      if (tickTimerRef.current !== null) window.clearTimeout(tickTimerRef.current);
      worker?.terminate();
      workerRef.current = null;
    };
  }, [requestDetail, requestTick, select]);

  // 表示トグルをシーンへ反映
  useEffect(() => {
    sceneRef.current?.setTrailVisibility(showOrbit, showGround);
  }, [showOrbit, showGround, selectedIndex]);

  useEffect(() => {
    sceneRef.current?.setThinning(thinning);
  }, [thinning]);

  useEffect(() => {
    sceneRef.current?.setFollow(follow);
  }, [follow]);

  // ------------------------------------------------------------ フィルタ

  const bitOf = useCallback((name: string) => groupIndexRef.current?.names.indexOf(name) ?? -1, []);

  const toggleGroup = useCallback(
    (name: string) => {
      const bit = bitOf(name);
      if (bit === -1) return;
      setFilterMaskState((current) => {
        const next = current ^ (1 << bit);
        sceneRef.current?.setFilterMask(next);
        return next;
      });
    },
    [bitOf],
  );

  const setAllGroups = useCallback((enabled: boolean) => {
    const groupIndex = groupIndexRef.current;
    const next = enabled ? (groupIndex ? groupIndex.allMask : -1) : 0;
    setFilterMaskState(next);
    sceneRef.current?.setFilterMask(next);
  }, []);

  const isGroupEnabled = useCallback(
    (name: string) => {
      const bit = bitOf(name);
      return bit !== -1 && (filterMask & (1 << bit)) !== 0;
    },
    [bitOf, filterMask],
  );

  // ------------------------------------------------------------ 検索

  const search = useCallback((query: string): SearchHit[] => {
    const cat = catalogRef.current;
    const trimmed = query.trim();
    if (!cat || trimmed.length === 0) return [];

    const upper = trimmed.toUpperCase();
    const namesUpper = namesUpperRef.current;
    // 数字だけの入力は NORAD ID の完全一致も狙う
    const asNumber = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
    const prefix: SearchHit[] = [];
    const contains: SearchHit[] = [];

    for (let i = 0; i < cat.count; i += 1) {
      const id = cat.ids[i]!;
      if (id === asNumber) {
        prefix.unshift({ index: i, noradId: id, name: cat.names[i]! });
        continue;
      }
      const at = (namesUpper[i] ?? '').indexOf(upper);
      if (at === 0) prefix.push({ index: i, noradId: id, name: cat.names[i]! });
      else if (at > 0 && contains.length < 50) {
        contains.push({ index: i, noradId: id, name: cat.names[i]! });
      }
      if (prefix.length >= 50) break;
    }

    return [...prefix, ...contains].slice(0, 50);
  }, []);

  // ------------------------------------------------------------ 時刻

  const setRate = useCallback((next: number) => {
    clockRef.current.setRate(next);
    setRateState(next);
    sceneRef.current?.setTimeScale(clockRef.current.effectiveScale);
  }, []);

  const togglePaused = useCallback(() => {
    setPaused((current) => {
      const next = !current;
      clockRef.current.setPaused(next);
      sceneRef.current?.setTimeScale(clockRef.current.effectiveScale);
      return next;
    });
  }, []);

  const setOffsetHours = useCallback(
    (hours: number) => {
      setOffsetHoursState(hours);
      clockRef.current.jumpToOffset(hours * 3600_000);
      // 時刻が飛んだら軌道線も引き直す
      if (selectedRef.current >= 0) requestOrbit(selectedRef.current);
    },
    [requestOrbit],
  );

  const resetToNow = useCallback(() => {
    setOffsetHoursState(0);
    clockRef.current.resetToNow();
    if (selectedRef.current >= 0) requestOrbit(selectedRef.current);
  }, [requestOrbit]);

  // ------------------------------------------------------------ 可視パス

  const useCurrentLocation = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setPassesError('この環境では現在地を取得できません。緯度経度を直接入力してください。');
      return;
    }
    setPassesError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setObserver({
          latitudeDeg: position.coords.latitude,
          longitudeDeg: position.coords.longitude,
          altitudeKm: (position.coords.altitude ?? 0) / 1000,
        });
      },
      (err) => {
        setPassesError(`現在地を取得できませんでした (${err.message})。緯度経度を直接入力してください。`);
      },
      { timeout: 10000, maximumAge: 600000 },
    );
  }, []);

  const setManualObserver = useCallback((latDeg: number, lonDeg: number) => {
    setPassesError(null);
    setObserver({ latitudeDeg: latDeg, longitudeDeg: lonDeg, altitudeKm: 0 });
  }, []);

  useEffect(() => {
    observerRef.current = observer;
  }, [observer]);

  const requestPasses = useCallback(() => {
    const index = selectedRef.current;
    const obs = observerRef.current;
    if (index < 0) {
      setPassesError('先に衛星を選択してください。');
      return;
    }
    if (!obs) {
      setPassesError('観測地点を設定してください。');
      return;
    }
    setPassesError(null);
    setPassesBusy(true);
    setPasses(null);
    workerRef.current?.postMessage({
      type: 'passes',
      index,
      simTimeMs: clockRef.current.now(),
      observer: obs,
    });
  }, []);

  const focusSelected = useCallback(() => sceneRef.current?.focusSelected(), []);

  const setFollow = useCallback((value: boolean) => setFollowState(value), []);
  const setShowOrbit = useCallback((value: boolean) => setShowOrbitState(value), []);
  const setShowGround = useCallback((value: boolean) => setShowGroundState(value), []);
  const setThinning = useCallback((value: boolean) => setThinningState(value), []);

  return useMemo(
    () => ({
      canvasRef,
      status,
      catalog,
      meta,
      selectedIndex,
      detail,
      hoverName,
      select,
      selectByNoradId,
      focusSelected,
      filterMask,
      toggleGroup,
      setAllGroups,
      isGroupEnabled,
      search,
      simTimeMs,
      rate,
      paused,
      offsetHours,
      setRate,
      togglePaused,
      setOffsetHours,
      resetToNow,
      follow,
      setFollow,
      showOrbit,
      setShowOrbit,
      showGround,
      setShowGround,
      thinning,
      setThinning,
      observer,
      passes,
      passesBusy,
      passesError,
      useCurrentLocation,
      setManualObserver,
      requestPasses,
    }),
    [
      status, catalog, meta, selectedIndex, detail, hoverName, select, selectByNoradId,
      focusSelected, filterMask, toggleGroup, setAllGroups, isGroupEnabled, search,
      simTimeMs, rate, paused, offsetHours, setRate, togglePaused, setOffsetHours, resetToNow,
      follow, setFollow, showOrbit, setShowOrbit, showGround, setShowGround, thinning, setThinning,
      observer, passes, passesBusy, passesError, useCurrentLocation, setManualObserver, requestPasses,
    ],
  );
}
