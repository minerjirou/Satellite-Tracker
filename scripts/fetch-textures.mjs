#!/usr/bin/env node
/**
 * NASA の地球テクスチャを取得して public/textures/ に配置する。
 *
 * 一度実行して成果物をコミットする前提のスクリプト。ビルドのたびに NASA の
 * サーバへ取りに行くと、向こうが落ちているだけでビルドが壊れてしまうため。
 *
 * 元画像は 5400px あり、モバイル GPU の最大テクスチャサイズ(多くは 4096)を
 * 超えるので縮小が必須。
 *
 *   node scripts/fetch-textures.mjs
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'textures');

const TEXTURES = [
  {
    name: 'earth_day.jpg',
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg',
    width: 4096,
    height: 2048,
    quality: 82,
    credit: 'NASA Earth Observatory — Blue Marble: Next Generation (2004-12)',
  },
  {
    name: 'earth_night.jpg',
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/79000/79765/dnb_land_ocean_ice.2012.3600x1800.jpg',
    width: 2048,
    height: 1024,
    quality: 80,
    credit: 'NASA Earth Observatory — Earth at Night (VIIRS Day/Night Band, 2012)',
  },
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const force = process.argv.includes('--force');

  for (const texture of TEXTURES) {
    const target = join(OUT_DIR, texture.name);
    if (!force && (await exists(target))) {
      console.log(`${texture.name} は既にあります (--force で再取得)`);
      continue;
    }

    console.log(`取得中: ${texture.url}`);
    const res = await fetch(texture.url);
    if (!res.ok) throw new Error(`${texture.name}: HTTP ${res.status}`);
    const source = Buffer.from(await res.arrayBuffer());
    console.log(`  元画像 ${(source.length / 1024 / 1024).toFixed(2)} MB`);

    const resized = await sharp(source)
      .resize(texture.width, texture.height, { fit: 'fill', kernel: 'lanczos3' })
      .jpeg({ quality: texture.quality, progressive: true, mozjpeg: true })
      .toBuffer();

    await writeFile(target, resized);
    console.log(
      `  → ${texture.name} ${texture.width}x${texture.height} / ${(resized.length / 1024).toFixed(0)} KB`,
    );
  }

  const credits = [
    '# テクスチャの出典',
    '',
    'このディレクトリの画像は NASA が公開しているパブリックドメイン素材を',
    '縮小・再圧縮したものです。`scripts/fetch-textures.mjs` で再生成できます。',
    '',
    ...TEXTURES.map((t) => `- **${t.name}** — ${t.credit}\n  出典: ${t.url}`),
    '',
    'NASA の画像利用ポリシー: https://www.nasa.gov/nasa-brand-center/images-and-media/',
    '',
  ].join('\n');
  await writeFile(join(OUT_DIR, 'CREDITS.md'), credits);
  console.log('\nCREDITS.md を書き出しました');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
