# Satellite Tracker

CelesTrak が公開している実測の軌道要素（GP/TLE）をもとに、いま地球を回っている人工衛星を
3D の地球の周りにリアルタイムで描画する Web アプリです。

- **実データ** — CelesTrak の `active` カタログ（約 13,000 基）を 2 時間ごとに取得
- **本物の軌道計算** — SGP4/SDP4（satellite.js、WASM 版）で伝播
- **グループ分類** — CelesTrak の公式グループ所属をそのまま使用（名前からの推測はしない）
- **Cloudflare Workers** — 無料プランのまま運用できる構成

---

## 動かす

```bash
npm install

# 地球テクスチャを取得（初回のみ。成果物はリポジトリに含まれています）
npm run textures

# ターミナル 1: API を担う Worker
npm run dev:worker      # http://127.0.0.1:8787

# ターミナル 2: フロントエンド（/api は上の Worker にプロキシされます）
npm run dev             # http://localhost:5173
```

初回は KV が空なので、`/api/tle` へのアクセス時に Worker が CelesTrak から取得して KV を埋めます。

---

## 設計

### なぜサーバを挟むのか

CelesTrak の `gp.php` は CORS を許可しているので、ブラウザから直接叩くことは技術的には可能です。
しかし **「1 更新サイクル（2 時間）につき GROUP ごとに 1 ダウンロード」** という制限があり、
2 回目以降は 403 が返ります（実際に確認済み。本文には
`GP data has not updated since your last successful download of GROUP=active` と書かれています）。

さらに 100MB/日 を超えると IP がブロックされ、403/404 を 2 時間に 50 回出しても同様です。
つまり**ブラウザ直叩きはリロード 2 回目で壊れる**ため、取得回数を構造的に 1 回へ固定する必要があります。

```
CelesTrak
   │  2時間に1回だけ（Cron Trigger）
   ▼
Cloudflare Worker ──▶ Workers KV ──▶ /api/tle ──▶ ブラウザ（何人来ても KV を読むだけ）
```

### なぜ集計を GitHub Actions でやるのか

Workers Free プランの CPU 上限は 10ms で、**これは Cron Trigger にも適用されます**
（`CPU time per Cron Trigger: Free 10 ms`）。2MB のテキストから NORAD ID を抜く処理は確実に超えます。

そこで、更新頻度と処理の重さで実行場所を分けました。

| データ | 中身 | 頻度 | 実行場所 | CelesTrak への転送量 |
|---|---|---|---|---|
| `tle:active` | 軌道要素 3LE | 2 時間ごと | Worker の Cron Trigger | 約 2.1MB × 12 = 25MB/日 |
| `groups:v1` | グループ所属のビットマスク | 1 日 1 回 | GitHub Actions | 約 2.0MB × 1 = 2MB/日 |

合計 約 27MB/日 で、CelesTrak の 100MB/日 制限に対して十分な余裕があります。
実行元 IP が分かれるため、片方の制限がもう片方に波及しないという副次的な利点もあります。

Worker がやるのは「fetch → `arrayBuffer()` → `KV.put()`」と「`KV.get(stream)` → そのまま返す」だけです。
`res.text()` を使わないのは、2.1MB の UTF-8 デコードだけで CPU 予算を使い切ってしまうためです。

### 分類はグループ所属を正とする

名前からの推測はしません。たとえば GLONASS 衛星の名前は `COSMOS 2569` のようになっていて、
他の COSMOS 衛星と区別できないためです。

15 グループを 32bit のビットマスクで保持しているので、1 基が複数グループに属する状態
（GPS は `gnss` かつ `military`）をそのまま表現でき、フィルタ UI はマスクの AND だけで動きます。
シェーダにも整数属性として渡しているので、チェックボックスの操作は uniform 1 つの更新で済みます。

CelesTrak のグループはカタログ全体を覆っていないため、どのグループにも属さない衛星には
**「その他」の合成ビット**を立てています。これを省くとマスクが 0 になり、
フィルタに一切一致せずシェーダで捨てられてしまいます（実データの大半がこれに該当します）。
「その他」に入った衛星だけは、軌道の形（低軌道 / 中軌道 / 静止 / 長楕円）で色分けしています。

### 13,000 基を 60fps で動かす

satellite.js 7 の `BulkPropagator`（WASM）を Web Worker で回しています。実測値：

| 方式 | 13,000 基 / 1 時刻 |
|---|---|
| WASM `BulkPropagator` | **2.85 ms** |
| 純 JS `propagate()` ループ | 5.40 ms |

どちらも 60fps の 16.7ms 予算に収まりますが、メインスレッドは描画に専念させたいので
計算はすべて Worker で行い、位置は transferable な `Float32Array` で渡しています
（バッファはメインスレッドから返却して再利用する ping-pong 方式）。

Worker は 20Hz でしか回さず、**メインスレッドは速度ベクトルで 1 次外挿**して毎フレーム位置を作ります。
50ms 先の外挿誤差は向心加速度から見て 1cm 程度（8.7 m/s² × 0.05² ÷ 2）なので、
2 サンプル間を補間するために 1 フレーム遅らせるより素直で、しかも遅延がありません。

描画は単一の `THREE.Points` にまとめ、色・サイズ・表示可否をカスタムシェーダで出し分けています。
遠景では Starlink などの大規模コンステレーションだけを間引きます（有人・GNSS は常に全数表示）。

WASM の初期化に失敗した場合は自動的に純 JS の伝播へフォールバックします。

---

## 機能

- 昼夜のターミネータと都市光を持つ地球（太陽位置はシミュレーション時刻に連動）
- 衛星名 / NORAD ID の検索、クリックでの選択、カメラ追従
- 詳細パネル: 所属グループ・高度・対地速度・緯度経度・軌道傾斜角・離心率・周期・遠地点/近地点・日照状態・生 TLE
- 軌道線（1 周分）と地上軌跡（日付変更線で正しく分断）
- 時刻コントロール: 一時停止 / 1×〜3600× / 巻き戻し / ±48 時間スクラブ / 現在時刻へ復帰
- 可視パス予測: 観測地から今後 48 時間、仰角 10° 以上のパスを列挙。
  衛星が日照中かつ空が暗い（太陽高度 < −6°）パスは肉眼可視としてマーク

---

## デプロイ（Cloudflare Workers）

```bash
# 1. Cloudflare にログイン（ブラウザが開きます）
npx wrangler login

# 2. KV 名前空間を作成し、出力された id を wrangler.jsonc に書き込む
npx wrangler kv namespace create SATCACHE

# 3. デプロイ
npm run deploy
```

初回デプロイ直後は KV が空ですが、最初の `/api/tle` アクセスで Worker が CelesTrak から
取得して KV を埋めるため、cron の発火を待たずに動きます。

グループ所属は GitHub Actions から投入します。リポジトリに以下を登録してください。

| 種別 | 名前 | 内容 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | **Workers Scripts: Edit** と **Workers KV Storage: Edit** の権限が必要 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare ダッシュボードのアカウント ID |
| Variable | `KV_NAMESPACE_ID` | 手順 2 で作成した KV の id |
| Variable | `DEPLOY_ENABLED` | `true` にすると main への push で自動デプロイ |

登録後、Actions から「グループ所属の更新」を手動実行すると即座に反映されます。
未登録でもアプリは動きます（`/api/groups` が 204 を返し、軌道の形による分類にフォールバックします）。

---

## 出典

- **軌道要素**: [CelesTrak](https://celestrak.org/) — Dr. T.S. Kelso
- **地球テクスチャ**: NASA Earth Observatory
  — [Blue Marble: Next Generation](https://visibleearth.nasa.gov/images/73909/) /
  [Earth at Night](https://visibleearth.nasa.gov/images/79765/) （パブリックドメイン）
- **軌道計算**: [satellite.js](https://github.com/shashwatak/satellite-js) — SGP4/SDP4
- **描画**: [three.js](https://threejs.org/)

CelesTrak のデータ利用にあたっては、同サイトの
[利用条件](https://celestrak.org/publications/) に従ってください。
このアプリは CelesTrak への負荷を 2 時間に 1 リクエストへ抑える設計になっています。

## ライセンス

MIT
