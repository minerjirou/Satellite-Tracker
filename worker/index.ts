/**
 * Satellite Tracker — Cloudflare Worker
 *
 * 役割は意図的に最小限に絞ってある。
 *
 * CelesTrak には「1 更新サイクル(2h)につき GROUP ごと 1 ダウンロード」という厳しい制限があり、
 * ブラウザから直接叩くとリロードのたびに 403 が返る。そこで Cron Trigger が 2 時間に 1 度だけ
 * 取得して KV に格納し、クライアントは KV を読むだけにしている。
 *
 * また Workers Free プランは Cron Trigger も含めて CPU 10ms しか使えないため、
 * この Worker は「バイト列を右から左へ受け渡す」以上のことをしない。
 * 文字列化・パース・集計は一切行わない(グループ集計は GitHub Actions 側の責務)。
 */

export interface Env {
  SATCACHE: KVNamespace;
  ASSETS: Fetcher;
}

/**
 * 形式に OMM (Orbit Mean-Elements Message, CCSDS 502.0-B-3) の JSON 表現を使う。
 *
 * TLE 系形式(3LE/2LE)はカタログ番号が 5 桁しか入らないため、10 万番以上の物体を
 * CelesTrak が出力してくれない(404 "No GP data found" が返る)。実測では active の
 * うち 327 基がこれに該当し、直近の打ち上げがまるごと欠落していた。
 *
 * 生のサイズは CSV の 3 倍(7.04MB 対 2.36MB)だが、CelesTrak も Cloudflare も
 * gzip を返すため実際の転送量はほぼ変わらない(1.01MB 対 0.83MB)。
 * 項目名が各レコードに入っている自己記述的な形式なので、CelesTrak が列を
 * 増減しても壊れないぶん CSV より堅い。
 */
const CELESTRAK_GP_URL =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json';

/** CelesTrak は自動クライアントに素性を名乗ることを求めている */
const USER_AGENT =
  'satellite-tracker/0.1 (+https://github.com/Minerjirou/Satellite-Tracker)';

const KEY_GP = 'gp:active';
const KEY_GROUPS = 'groups:v1';
const KEY_STATUS = 'meta:status';

interface GpMetadata {
  fetchedAt: string;
  bytes: number;
}

interface GroupsMetadata {
  fetchedAt: string;
  count: number;
}

interface StatusRecord {
  lastRunAt: string;
  ok: boolean;
  error?: string;
  bytes?: number;
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers ?? {}),
    },
  });

/** 1 回の取得に許す時間。CelesTrak は通常 2 秒ほどで返す。 */
const FETCH_TIMEOUT_MS = 45_000;

/** 接続レベルの失敗に対する再試行間隔。cron の実時間上限は 15 分なので待つ余裕はある。 */
const RETRY_DELAYS_MS = [3_000, 12_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * CelesTrak から active カタログを取得する。
 * 呼び出し側で ok を確認すること — 失敗時に KV を上書きしてはいけない。
 *
 * 再試行の方針は「誰が断ったのか」で分ける:
 *
 * - **403 / 404 は CelesTrak 自身の返答**。「まだ更新されていない」「該当データが無い」を
 *   意味しており、叩き直しても結果は変わらない。CelesTrak は 2 時間に 50 回の
 *   403/404 を IP ブロックの条件にしているので、**絶対に再試行しない**。
 * - **5xx やネットワーク例外は CelesTrak に届いていない**。実運用で毎時ちょうどの
 *   cron が 522(Cloudflare がオリジンに到達できない)を繰り返した一方、
 *   半端な時刻に走らせたフォールバックは成功していた。
 *   毎時 :00 に世界中の cron が集中するのが原因とみて、こちらは短い待機を挟んで再試行する。
 */
async function fetchCelestrakGp(): Promise<Response> {
  let lastError = 'unknown';

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);

    try {
      const res = await fetch(CELESTRAK_GP_URL, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      // CelesTrak が明示的に断った場合は、そのまま呼び出し側へ返す(再試行しない)
      if (res.ok || res.status < 500) return res;

      lastError = `HTTP ${res.status}`;
      console.warn(`CelesTrak ${lastError} (${attempt + 1} 回目) — 接続レベルの失敗として再試行します`);
    } catch (err) {
      lastError = String(err);
      console.warn(`CelesTrak への接続に失敗 (${attempt + 1} 回目): ${lastError}`);
    }
  }

  // 再試行を使い切った。呼び出し側が !ok として扱えるよう Response の形で返す。
  return new Response(lastError, { status: 599, statusText: 'Upstream Unreachable' });
}

/** ArrayBuffer 経由で KV に保存する。text() や json() を使うと CPU 制限に触れる。 */
async function storeGp(env: Env, buf: ArrayBuffer): Promise<GpMetadata> {
  const metadata: GpMetadata = {
    fetchedAt: new Date().toISOString(),
    bytes: buf.byteLength,
  };
  await env.SATCACHE.put(KEY_GP, buf, { metadata });
  return metadata;
}

async function handleGp(env: Env, ctx: ExecutionContext): Promise<Response> {
  const cached = await env.SATCACHE.getWithMetadata<GpMetadata>(KEY_GP, {
    type: 'stream',
  });

  if (cached.value) {
    return new Response(cached.value, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // ブラウザ 30 分 / CDN 2 時間。CelesTrak の更新サイクルに合わせている
        'cache-control':
          'public, max-age=1800, s-maxage=7200, stale-while-revalidate=86400',
        'x-fetched-at': cached.metadata?.fetchedAt ?? '',
        'x-source': 'kv',
      },
    });
  }

  // KV が空 = 初回デプロイから最初の cron 発火までの隙間。
  // ここだけは同期的に CelesTrak を叩いて穴埋めする。
  const res = await fetchCelestrakGp();
  if (!res.ok) {
    return json(
      {
        error: 'CelesTrak からデータを取得できませんでした',
        status: res.status,
        hint: '2 時間ごとの定期取得が成功するまでお待ちください',
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  const buf = await res.arrayBuffer();
  ctx.waitUntil(storeGp(env, buf));

  return new Response(buf, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=1800, s-maxage=7200',
      'x-fetched-at': new Date().toISOString(),
      'x-source': 'origin',
    },
  });
}

async function handleGroups(env: Env): Promise<Response> {
  const cached = await env.SATCACHE.getWithMetadata<GroupsMetadata>(KEY_GROUPS, {
    type: 'stream',
  });

  // 未投入なら 204。クライアントは軌道要素ベースの暫定分類にフォールバックする。
  if (!cached.value) {
    return new Response(null, {
      status: 204,
      headers: { 'cache-control': 'no-store', 'x-source': 'empty' },
    });
  }

  return new Response(cached.value, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 1 日 1 回しか更新されないので長めに寝かせる
      'cache-control':
        'public, max-age=21600, s-maxage=43200, stale-while-revalidate=86400',
      'x-fetched-at': cached.metadata?.fetchedAt ?? '',
    },
  });
}

/**
 * KV の list() は値を読まずに metadata を返してくれるので、
 * 7MB の OMM データや 120KB の groups.json を一切ロードせずに更新時刻を知ることができる。
 */
async function handleMeta(env: Env): Promise<Response> {
  const listed = await env.SATCACHE.list<GpMetadata | GroupsMetadata>();
  const byName = new Map(listed.keys.map((k) => [k.name, k.metadata]));
  const status = await env.SATCACHE.get<StatusRecord>(KEY_STATUS, 'json');

  return json(
    {
      gp: (byName.get(KEY_GP) as GpMetadata | undefined) ?? null,
      groups: (byName.get(KEY_GROUPS) as GroupsMetadata | undefined) ?? null,
      lastRun: status ?? null,
      source: { name: 'CelesTrak', url: 'https://celestrak.org/' },
    },
    { headers: { 'cache-control': 'public, max-age=300' } },
  );
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'Method Not Allowed' }, { status: 405 });
    }

    switch (url.pathname) {
      case '/api/gp':
        return handleGp(env, ctx);
      case '/api/groups':
        return handleGroups(env);
      case '/api/meta':
        return handleMeta(env);
      default:
        return json({ error: 'Not Found' }, { status: 404 });
    }
  },

  /**
   * 2 時間ごと(1 日 12 回)。CelesTrak の更新サイクルに合わせてある。
   * 失敗してもリトライしない — CelesTrak は 403/404 の連打を IP ブロックの対象にしている。
   */
  async scheduled(_event, env, _ctx): Promise<void> {
    const lastRunAt = new Date().toISOString();

    const fail = (error: string) =>
      env.SATCACHE.put(
        KEY_STATUS,
        JSON.stringify({ lastRunAt, ok: false, error } satisfies StatusRecord),
      );

    let res: Response;
    try {
      res = await fetchCelestrakGp();
    } catch (err) {
      console.error('CelesTrak fetch threw', err);
      await fail(`fetch failed: ${String(err)}`);
      return;
    }

    if (!res.ok) {
      // 既存の gp:active はそのまま残す — 古いデータの方が無いよりずっとマシ。
      // 599 は再試行を使い切ったことを表す自前のステータスで、本文に原因が入っている。
      const reason =
        res.status === 599 ? `到達できず: ${await res.text()}` : `HTTP ${res.status}`;
      console.error(`CelesTrak ${reason}; keeping previous KV value`);
      await fail(reason);
      return;
    }

    const buf = await res.arrayBuffer();

    // 壊れたレスポンス(エラーページ等)で正常データを潰さないための下限チェック
    if (buf.byteLength < 100_000) {
      console.error(`Payload too small (${buf.byteLength} bytes); keeping previous KV value`);
      await fail(`suspiciously small payload: ${buf.byteLength} bytes`);
      return;
    }

    const metadata = await storeGp(env, buf);
    await env.SATCACHE.put(
      KEY_STATUS,
      JSON.stringify({
        lastRunAt,
        ok: true,
        bytes: metadata.bytes,
      } satisfies StatusRecord),
    );
  },
} satisfies ExportedHandler<Env>;
