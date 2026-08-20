/**
 * satellite.js のマルチスレッド WASM ビルドの差し替え先。
 *
 * pthreads 版は SharedArrayBuffer を使うため、ページに COOP/COEP ヘッダを
 * 立てて cross-origin isolation を有効にしないと動かない。単一スレッドでも
 * 13,000 基を 2.85ms で処理できる(実測)ので、このアプリでは使わない。
 *
 * satellite.js の index が createMultiThreadRuntime を re-export している都合で
 * バンドラが必ずこの依存を辿ってしまうため、実体をスタブに差し替えて
 * 130KB 超の未使用コードがバンドルに入るのを防いでいる。
 */
export default function createWasmModuleMultiThread(): never {
  throw new Error(
    'マルチスレッド WASM はこのアプリでは無効化されています (createSingleThreadRuntime を使ってください)',
  );
}
