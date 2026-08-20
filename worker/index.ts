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

const CELESTRAK_TLE_URL =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=3le';

/** CelesTrak は自動クライアントに素性を名乗ることを求めている */
const USER_AGENT =
  'satellite-tracker/0.1 (+https://github.com/Minerjirou/Satellite-Tracker)';

const KEY_TLE = 'tle:active';
const KEY_GROUPS = 'groups:v1';
const KEY_STATUS = 'meta:status';

interface TleMetadata {
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

/**
 * CelesTrak から active カタログを取得する。
 * 呼び出し側で ok を確認すること — 失敗時に KV を上書きしてはいけない。
 */
function fetchCelestrakTle(): Promise<Response> {
  return fetch(CELESTRAK_TLE_URL, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/plain' },
  });
}

/** ArrayBuffer 経由で KV に保存する。text() を使うと 2.1MB の UTF-8 デコードで CPU 制限に触れる。 */
async function storeTle(env: Env, buf: ArrayBuffer): Promise<TleMetadata> {
  const metadata: TleMetadata = {
    fetchedAt: new Date().toISOString(),
    bytes: buf.byteLength,
  };
  await env.SATCACHE.put(KEY_TLE, buf, { metadata });
  return metadata;
}

async function handleTle(env: Env, ctx: ExecutionContext): Promise<Response> {
  const cached = await env.SATCACHE.getWithMetadata<TleMetadata>(KEY_TLE, {
    type: 'stream',
  });

  if (cached.value) {
    return new Response(cached.value, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
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
  const res = await fetchCelestrakTle();
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
  ctx.waitUntil(storeTle(env, buf));

  return new Response(buf, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
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
 * 2.1MB の TLE や 150KB の groups.json を一切ロードせずに更新時刻を知ることができる。
 */
async function handleMeta(env: Env): Promise<Response> {
  const listed = await env.SATCACHE.list<TleMetadata | GroupsMetadata>();
  const byName = new Map(listed.keys.map((k) => [k.name, k.metadata]));
  const status = await env.SATCACHE.get<StatusRecord>(KEY_STATUS, 'json');

  return json(
    {
      tle: (byName.get(KEY_TLE) as TleMetadata | undefined) ?? null,
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
      case '/api/tle':
        return handleTle(env, ctx);
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
      res = await fetchCelestrakTle();
    } catch (err) {
      console.error('CelesTrak fetch threw', err);
      await fail(`fetch failed: ${String(err)}`);
      return;
    }

    if (!res.ok) {
      // 既存の tle:active はそのまま残す — 古いデータの方が無いよりずっとマシ
      console.error(`CelesTrak returned HTTP ${res.status}; keeping previous KV value`);
      await fail(`HTTP ${res.status}`);
      return;
    }

    const buf = await res.arrayBuffer();

    // 壊れたレスポンス(エラーページ等)で正常データを潰さないための下限チェック
    if (buf.byteLength < 100_000) {
      console.error(`Payload too small (${buf.byteLength} bytes); keeping previous KV value`);
      await fail(`suspiciously small payload: ${buf.byteLength} bytes`);
      return;
    }

    const metadata = await storeTle(env, buf);
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
