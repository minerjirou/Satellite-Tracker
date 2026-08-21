/**
 * Worker(Cloudflare) が仲介する API。
 *
 * ブラウザから CelesTrak を直接叩いてはいけない。CelesTrak は
 * 「1 更新サイクル(2h)につき GROUP ごと 1 ダウンロード」しか許しておらず、
 * 直叩きするとリロード 2 回目から 403 が返る。
 */

import type { GroupsPayload } from './groups';

export interface CatalogMeta {
  gp: { fetchedAt: string; bytes: number } | null;
  groups: { fetchedAt: string; count: number } | null;
  lastRun: { lastRunAt: string; ok: boolean; error?: string; bytes?: number } | null;
  source: { name: string; url: string };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * OMM (Orbit Mean-Elements Message) レコードの配列と、その取得時刻。
 *
 * TLE 形式を使わないのは、カタログ番号欄が 5 桁しかなく 10 万番以上の物体が
 * 落ちてしまうため(実測で active の 327 基が該当)。
 */
export async function fetchGp(
  signal?: AbortSignal,
): Promise<{ records: unknown; fetchedAt: string | null }> {
  const res = await fetch('/api/gp', { signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* JSON でなければステータスだけ使う */
    }
    throw new ApiError(`軌道要素を取得できませんでした: ${detail}`, res.status);
  }
  return { records: await res.json(), fetchedAt: res.headers.get('x-fetched-at') };
}

/**
 * グループ所属。まだ GitHub Actions が一度も走っていない場合は 204 が返る。
 * その場合は null を返し、呼び出し側は軌道形状ベースの分類にフォールバックする。
 */
export async function fetchGroups(signal?: AbortSignal): Promise<GroupsPayload | null> {
  const res = await fetch('/api/groups', { signal });
  if (res.status === 204) return null;
  if (!res.ok) {
    console.warn(`グループ情報の取得に失敗しました (HTTP ${res.status}) — 軌道形状から分類します`);
    return null;
  }
  try {
    return (await res.json()) as GroupsPayload;
  } catch (err) {
    console.warn('グループ情報を解釈できませんでした', err);
    return null;
  }
}

export async function fetchMeta(signal?: AbortSignal): Promise<CatalogMeta | null> {
  try {
    const res = await fetch('/api/meta', { signal });
    if (!res.ok) return null;
    return (await res.json()) as CatalogMeta;
  } catch {
    return null;
  }
}
