/**
 * シミュレーション時刻。
 *
 * 実時間とは独立に進み、倍率・一時停止・任意時刻へのジャンプができる。
 * 「いま何時のつもりで計算しているか」の一点だけを持ち、
 * 描画側もWorker 側もここから時刻をもらう。
 */
export class SimClock {
  /** 基準となる実時刻 (performance.now) */
  private anchorReal: number;
  /** その瞬間のシミュレーション時刻 (UNIX ms) */
  private anchorSim: number;
  private rateValue = 1;
  private pausedValue = false;

  constructor() {
    this.anchorReal = performance.now();
    this.anchorSim = Date.now();
  }

  now(): number {
    if (this.pausedValue) return this.anchorSim;
    return this.anchorSim + (performance.now() - this.anchorReal) * this.rateValue;
  }

  /** 倍率や一時停止を変えるとき、現在時刻を基準に取り直す(時刻が飛ばないように) */
  private reanchor(): void {
    this.anchorSim = this.now();
    this.anchorReal = performance.now();
  }

  get rate(): number {
    return this.rateValue;
  }

  setRate(rate: number): void {
    this.reanchor();
    this.rateValue = rate;
  }

  get paused(): boolean {
    return this.pausedValue;
  }

  setPaused(paused: boolean): void {
    this.reanchor();
    this.pausedValue = paused;
  }

  /** 実時間 1 秒あたりに進むシミュレーション秒数。停止中は 0。 */
  get effectiveScale(): number {
    return this.pausedValue ? 0 : this.rateValue;
  }

  jumpTo(simTimeMs: number): void {
    this.anchorSim = simTimeMs;
    this.anchorReal = performance.now();
  }

  /** 現在時刻からのずれ(ミリ秒)。UI のスライダーが示す値。 */
  offsetFromNow(): number {
    return this.now() - Date.now();
  }

  jumpToOffset(offsetMs: number): void {
    this.jumpTo(Date.now() + offsetMs);
  }

  resetToNow(): void {
    this.jumpTo(Date.now());
  }
}
