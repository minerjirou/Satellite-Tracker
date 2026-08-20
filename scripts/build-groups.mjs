#!/usr/bin/env node
/**
 * CelesTrak の公式グループ所属を集計して groups.json を作る。
 *
 * なぜ Worker ではなくここでやるのか:
 * Workers Free プランは Cron Trigger も含めて CPU 10ms しか使えず、2MB のテキストから
 * NORAD ID を抜く処理は確実に超える。GitHub Actions には CPU 制限がないのでこちらに寄せている。
 *
 * 使い方:
 *   node scripts/build-groups.mjs [--previous <path>] [--out <path>]
 *
 * --previous を渡すと前回の結果にマージする。あるグループの取得に失敗しても
 * そのグループの前回分を保持できるので、一時的な 403 でデータが欠けない。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

/**
 * ビット位置がそのまま groups.json のマスクになる。
 * 並び順を変えると既存データの意味が変わるので、追加は必ず末尾に行うこと。
 */
export const GROUPS = [
  'stations',
  'visual',
  'last-30-days',
  'amateur',
  'cubesat',
  'starlink',
  'oneweb',
  'kuiper',
  'qianfan',
  'gnss',
  'geo',
  'weather',
  'resource',
  'science',
  'military',
];

const USER_AGENT =
  'satellite-tracker/0.1 (+https://github.com/Minerjirou/Satellite-Tracker)';

/** CelesTrak への負荷を散らすためのグループ間ウェイト */
const DELAY_MS = 1000;

/**
 * Alpha-5 形式のカタログ番号をデコードする。
 * 100000 以上の番号は先頭 1 桁を英字にして 5 桁に収める方式で表現される
 * (I と O は 1/0 と紛らわしいので使われない)。例: "A0000" = 100000
 */
const ALPHA5 = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function parseCatalogNumber(field) {
  const s = field.trim();
  if (!s) return NaN;
  const head = s[0].toUpperCase();
  const idx = ALPHA5.indexOf(head);
  if (idx === -1) return Number.parseInt(s, 10);
  const rest = Number.parseInt(s.slice(1), 10);
  if (Number.isNaN(rest)) return NaN;
  return (idx + 10) * 10000 + rest;
}

/**
 * TLE テキストから NORAD ID を抜き出す。
 * 1 行目のカラム 3-7 が カタログ番号(2LE/3LE 共通)。
 */
export function extractCatalogNumbers(text) {
  const ids = new Set();
  for (const rawLine of text.split('\n')) {
    if (rawLine.charCodeAt(0) !== 49 /* '1' */ || rawLine[1] !== ' ') continue;
    const id = parseCatalogNumber(rawLine.slice(2, 7));
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return ids;
}

async function fetchGroup(group) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=2le`;
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/plain' },
  });
  const text = await res.text();

  // CelesTrak は「該当なし」を 404 + "No GP data found" で返す。
  // これは障害ではなく空集合なので、そのグループのビットを正しく落とす必要がある。
  // (例: last-30-days は打ち上げが無い期間だとこの状態になる)
  if (res.status === 404 && text.trim() === 'No GP data found') {
    return new Set();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  // エラー時に短い HTML が返ることがある
  if (text.length < 100 || text.includes('<html')) {
    throw new Error(`unexpected payload (${text.length} bytes)`);
  }
  const ids = extractCatalogNumbers(text);
  if (ids.size === 0) throw new Error('no catalog numbers found');
  return ids;
}

function parseArgs(argv) {
  const args = { previous: null, out: 'groups.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--previous') args.previous = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

/** 前回の groups.json を Map<noradId, mask> に戻す。読めなければ空で始める。 */
async function loadPrevious(path) {
  if (!path) return { masks: new Map(), names: [] };
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    const masks = new Map();
    const ids = parsed.ids ?? [];
    const values = parsed.masks ?? [];
    for (let i = 0; i < ids.length; i += 1) masks.set(ids[i], values[i] ?? 0);
    console.log(`前回データを読み込みました: ${masks.size} 件 (${parsed.fetchedAt ?? '不明'})`);
    return { masks, names: parsed.names ?? [] };
  } catch (err) {
    console.warn(`前回データを読めませんでした (${err.message}) — 新規に作成します`);
    return { masks: new Map(), names: [] };
  }
}

/**
 * 前回のマスクは「グループ名 → ビット位置」の対応が変わっている可能性があるため、
 * 前回の names を使って現在のビット割り当てに詰め替える。
 */
function remapPrevious(masks, previousNames) {
  if (previousNames.length === 0) return new Map();
  const sameOrder =
    previousNames.length === GROUPS.length &&
    previousNames.every((n, i) => n === GROUPS[i]);
  if (sameOrder) return masks;

  console.log('グループの並びが変わっているのでビットを詰め替えます');
  const remapped = new Map();
  for (const [id, mask] of masks) {
    let next = 0;
    previousNames.forEach((name, oldBit) => {
      if ((mask & (1 << oldBit)) === 0) return;
      const newBit = GROUPS.indexOf(name);
      if (newBit !== -1) next |= 1 << newBit;
    });
    if (next !== 0) remapped.set(id, next);
  }
  return remapped;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const previous = await loadPrevious(args.previous);
  const masks = remapPrevious(previous.masks, previous.names);

  const succeeded = [];
  const failed = [];

  for (const [bit, group] of GROUPS.entries()) {
    if (bit > 0) await sleep(DELAY_MS);
    try {
      const ids = await fetchGroup(group);
      // このグループのビットを一旦全部落としてから、取得した衛星にだけ立て直す
      const flag = 1 << bit;
      for (const [id, mask] of masks) {
        if (mask & flag) masks.set(id, mask & ~flag);
      }
      for (const id of ids) masks.set(id, (masks.get(id) ?? 0) | flag);
      succeeded.push({ group, count: ids.size });
      console.log(`  ${group.padEnd(14)} ${String(ids.size).padStart(6)} 基`);
    } catch (err) {
      failed.push({ group, error: err.message });
      console.warn(`  ${group.padEnd(14)} 失敗: ${err.message} — 前回分を保持します`);
    }
  }

  if (succeeded.length === 0) {
    console.error('\n全グループの取得に失敗しました。KV は更新しません。');
    process.exit(1);
  }

  // マスクが 0 になった衛星(どのグループからも外れた)は落とす
  for (const [id, mask] of masks) {
    if (mask === 0) masks.delete(id);
  }

  const ids = [...masks.keys()].sort((a, b) => a - b);
  const output = {
    v: 1,
    fetchedAt: new Date().toISOString(),
    names: GROUPS,
    ids,
    masks: ids.map((id) => masks.get(id)),
  };

  const serialized = JSON.stringify(output);
  await writeFile(args.out, serialized);

  console.log(
    `\n${args.out} を書き出しました: ${ids.length} 件 / ${(serialized.length / 1024).toFixed(1)} KB`,
  );
  if (failed.length > 0) {
    console.log(`失敗したグループ: ${failed.map((f) => f.group).join(', ')}`);
  }

  // ワークフローから KV metadata として使えるように標準出力へ出す
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `count=${ids.length}\nfetched_at=${output.fetchedAt}\nfailed=${failed.length}\n`,
    );
  }
}

// 他のスクリプトから関数だけ import できるように、直接実行時のみ main を走らせる
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
