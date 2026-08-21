/**
 * Satellite Tracker — Cloudflare Worker
 *
 * この Worker は Workers KV を読んで返すだけで、CelesTrak には一切アクセスしない。
 *
 * 当初は Cron Trigger でここから取得していたが、**CelesTrak は Cloudflare の
 * 共有 egress IP からの大量転送を絞っている**ことが実測で判明した。
 *
 *   GitHub Actions      GROUP=active&FORMAT=json → HTTP 200 / 0.83 秒
 *   自宅の回線          同上                     → HTTP 200 / 2.03 秒
 *   Cloudflare Worker   同上                     → HTTP 522 / 19.5 秒でタイムアウト
 *   Cloudflare Worker   CATNR=25544 (423B)       → HTTP 200 / 0.47 秒
 *
 * 小さなリクエストは通るので恒久的な IP ブロックではないが、カタログ全体の
 * 取得は Cloudflare 側からは成立しない。そこで取得は GitHub Actions
 * (.github/workflows/elements.yml と groups.yml) の担当とし、
 * この Worker は KV → HTTP の変換だけを行う。
 *
 * 副次的な効果として、Workers Free プランの CPU 10ms 制限を気にする必要が
 * ほぼ無くなった。値はストリームのまま受け渡すのでデコードもパースもしない。
 */

export interface Env {
  SATCACHE: KVNamespace;
  ASSETS: Fetcher;
}

const KEY_GP = 'gp:active';
const KEY_GROUPS = 'groups:v1';

interface GpMetadata {
  fetchedAt: string;
  bytes: number;
}

interface GroupsMetadata {
  fetchedAt: string;
  count: number;
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
 * 軌道要素 — OMM (Orbit Mean-Elements Message) の JSON 表現。
 * KV の値をストリームのまま返すので、7MB あっても CPU はほとんど使わない。
 */
async function handleGp(env: Env): Promise<Response> {
  const cached = await env.SATCACHE.getWithMetadata<GpMetadata>(KEY_GP, {
    type: 'stream',
  });

  if (!cached.value) {
    return json(
      {
        error: '軌道要素がまだ読み込まれていません',
        hint: 'GitHub Actions の「軌道要素の更新」ワークフローを実行してください',
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  return new Response(cached.value, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // ブラウザ 30 分 / CDN 2 時間。CelesTrak の更新サイクルに合わせている
      'cache-control':
        'public, max-age=1800, s-maxage=7200, stale-while-revalidate=86400',
      'x-fetched-at': cached.metadata?.fetchedAt ?? '',
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
      headers: { 'cache-control': 'no-store' },
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
 * 7MB の OMM データを一切ロードせずに更新時刻を知ることができる。
 */
async function handleMeta(env: Env): Promise<Response> {
  const listed = await env.SATCACHE.list<GpMetadata | GroupsMetadata>();
  const byName = new Map(listed.keys.map((k) => [k.name, k.metadata]));

  return json(
    {
      gp: (byName.get(KEY_GP) as GpMetadata | undefined) ?? null,
      groups: (byName.get(KEY_GROUPS) as GroupsMetadata | undefined) ?? null,
      source: { name: 'CelesTrak', url: 'https://celestrak.org/' },
    },
    { headers: { 'cache-control': 'public, max-age=300' } },
  );
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'Method Not Allowed' }, { status: 405 });
    }

    switch (url.pathname) {
      case '/api/gp':
        return handleGp(env);
      case '/api/groups':
        return handleGroups(env);
      case '/api/meta':
        return handleMeta(env);
      default:
        return json({ error: 'Not Found' }, { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
