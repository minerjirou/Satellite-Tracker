/**
 * CelesTrak の公式グループ所属(ビットマスク)とその表示カテゴリへの変換。
 *
 * 分類は CelesTrak のグループを正としている。名前からの推測はしない —
 * 例えば GLONASS 衛星の名前は "COSMOS 2569" のようになっていて、
 * 名前だけでは他の COSMOS 衛星と区別できないため。
 */

/** Worker から返される groups.json の形。ビット位置は names の添字。 */
export interface GroupsPayload {
  v: number;
  fetchedAt: string;
  names: string[];
  ids: number[];
  masks: number[];
}

/**
 * 表示カテゴリ。数値はそのままシェーダの属性値になるので、
 * 追加するときは末尾に足すこと。
 */
export enum Category {
  Stations = 0,
  Starlink = 1,
  OneWeb = 2,
  Kuiper = 3,
  Qianfan = 4,
  Gnss = 5,
  Geo = 6,
  Weather = 7,
  Resource = 8,
  Science = 9,
  Military = 10,
  Amateur = 11,
  CubeSat = 12,
  Visual = 13,
  /** どのグループにも属さない衛星を軌道形状から振り分けた先 */
  Leo = 14,
  Meo = 15,
  Heo = 16,
}

export const CATEGORY_COUNT = 17;

export interface CategoryStyle {
  label: string;
  /** 0-1 の RGB。シェーダにそのまま渡す。 */
  color: [number, number, number];
  /** 基準点サイズの倍率。有人施設だけ大きく描く。 */
  sizeScale: number;
}

export const CATEGORY_STYLES: Record<Category, CategoryStyle> = {
  [Category.Stations]: { label: '宇宙ステーション', color: [1.0, 1.0, 1.0], sizeScale: 3.2 },
  [Category.Starlink]: { label: 'Starlink', color: [0.42, 0.72, 1.0], sizeScale: 0.8 },
  [Category.OneWeb]: { label: 'OneWeb', color: [0.72, 0.52, 1.0], sizeScale: 0.9 },
  [Category.Kuiper]: { label: 'Kuiper', color: [1.0, 0.55, 0.78], sizeScale: 0.9 },
  [Category.Qianfan]: { label: '千帆 (Qianfan)', color: [0.98, 0.45, 0.45], sizeScale: 0.9 },
  [Category.Gnss]: { label: '測位 (GNSS)', color: [1.0, 0.85, 0.28], sizeScale: 1.5 },
  [Category.Geo]: { label: '静止軌道', color: [1.0, 0.62, 0.22], sizeScale: 1.3 },
  [Category.Weather]: { label: '気象', color: [0.45, 0.9, 0.95], sizeScale: 1.3 },
  [Category.Resource]: { label: '地球観測', color: [0.5, 0.95, 0.6], sizeScale: 1.2 },
  [Category.Science]: { label: '科学', color: [0.35, 1.0, 0.78], sizeScale: 1.4 },
  [Category.Military]: { label: '軍事', color: [0.85, 0.45, 0.45], sizeScale: 1.1 },
  [Category.Amateur]: { label: 'アマチュア無線', color: [0.95, 0.75, 0.5], sizeScale: 1.2 },
  [Category.CubeSat]: { label: 'CubeSat', color: [0.75, 0.85, 0.5], sizeScale: 1.0 },
  [Category.Visual]: { label: '肉眼可視', color: [0.95, 0.95, 0.75], sizeScale: 1.4 },
  [Category.Leo]: { label: 'その他 低軌道', color: [0.35, 0.78, 0.82], sizeScale: 0.95 },
  [Category.Meo]: { label: 'その他 中軌道', color: [0.6, 0.7, 0.9], sizeScale: 1.0 },
  [Category.Heo]: { label: 'その他 長楕円軌道', color: [0.8, 0.6, 0.85], sizeScale: 1.0 },
};

/**
 * グループ名 → 表示カテゴリ。
 * 1 つの衛星は複数グループに属しうる(GPS は gnss かつ military)ので、
 * この配列の順序がそのまま優先順位になる。先に一致したものが表示色になる。
 */
const CATEGORY_PRIORITY: ReadonlyArray<readonly [string, Category]> = [
  ['stations', Category.Stations],
  ['starlink', Category.Starlink],
  ['oneweb', Category.OneWeb],
  ['kuiper', Category.Kuiper],
  ['qianfan', Category.Qianfan],
  ['gnss', Category.Gnss],
  ['geo', Category.Geo],
  ['weather', Category.Weather],
  ['resource', Category.Resource],
  ['science', Category.Science],
  ['military', Category.Military],
  ['amateur', Category.Amateur],
  ['cubesat', Category.CubeSat],
  ['visual', Category.Visual],
];

/**
 * どのグループにも属さない衛星に立てる合成ビットの名前。
 *
 * CelesTrak のグループはカタログ全体を覆っていないため、`active` に載っていても
 * どのグループにも入らない衛星が相当数ある(実データで約 9 割が debris 系グループ外)。
 * これらにビットを立てておかないと「マスク 0 = どのフィルタにも一致しない」となり、
 * シェーダで一律に捨てられてしまう。
 */
export const UNGROUPED = '__ungrouped';

/** フィルタ UI に出すグループの表示名 */
export const GROUP_LABELS: Record<string, string> = {
  [UNGROUPED]: 'その他（グループ未収載）',
  stations: '宇宙ステーション',
  visual: '肉眼可視',
  'last-30-days': '直近30日の打ち上げ',
  amateur: 'アマチュア無線',
  cubesat: 'CubeSat',
  starlink: 'Starlink',
  oneweb: 'OneWeb',
  kuiper: 'Kuiper',
  qianfan: '千帆 (Qianfan)',
  gnss: '測位 (GNSS)',
  geo: '静止軌道',
  weather: '気象',
  resource: '地球観測',
  science: '科学',
  military: '軍事',
};

/** 遠景で間引いてよい大規模コンステレーション。有人・GNSS などは常に全数表示する。 */
const THINNABLE_GROUPS = ['starlink', 'oneweb', 'kuiper', 'qianfan'];

/**
 * groups.json を「NORAD ID → マスク」の索引に開く。
 *
 * ビット位置はサーバ側の names 配列で決まるため、クライアントに定数として
 * 焼き込まず、受け取ったペイロードから毎回組み立てる。こうしておけば
 * サーバ側でグループを足しても、クライアントを直さずに追従できる。
 */
export class GroupIndex {
  /** CelesTrak 由来のグループ名に、合成の「その他」を足したもの。ビット位置はこの添字。 */
  readonly names: string[];
  /** CelesTrak から実際にグループ情報を受け取れたか */
  readonly hasGroups: boolean;
  readonly fetchedAt: string | null;
  /** 表示カテゴリ判定に使う「ビット → カテゴリ」の優先順リスト */
  private readonly priority: Array<{ flag: number; category: Category }>;
  private readonly maskById: Map<number, number>;
  private readonly ungroupedFlag: number;

  readonly thinnableMask: number;

  constructor(payload: GroupsPayload | null) {
    const sourceNames = payload?.names ?? [];
    this.hasGroups = sourceNames.length > 0;
    this.names = [...sourceNames, UNGROUPED];
    this.ungroupedFlag = 1 << sourceNames.length;
    this.fetchedAt = payload?.fetchedAt ?? null;
    this.maskById = new Map();

    if (payload) {
      const { ids, masks } = payload;
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        const mask = masks[i];
        if (id !== undefined && mask !== undefined) this.maskById.set(id, mask);
      }
    }

    const bitOf = (name: string) => this.names.indexOf(name);

    this.priority = [];
    for (const [name, category] of CATEGORY_PRIORITY) {
      const bit = bitOf(name);
      if (bit !== -1) this.priority.push({ flag: 1 << bit, category });
    }

    let thinnable = 0;
    for (const name of THINNABLE_GROUPS) {
      const bit = bitOf(name);
      if (bit !== -1) thinnable |= 1 << bit;
    }
    this.thinnableMask = thinnable;
  }

  get isEmpty(): boolean {
    return this.maskById.size === 0;
  }

  get size(): number {
    return this.maskById.size;
  }

  /**
   * グループ所属のビットマスク。
   * どのグループにも属さない衛星には「その他」のビットを立てて返すので、
   * 戻り値が 0 になることはない(= フィルタから漏れて消える衛星が出ない)。
   */
  maskFor(noradId: number): number {
    return this.maskById.get(noradId) ?? this.ungroupedFlag;
  }

  /** マスクに含まれるグループ名を、優先順ではなく定義順で返す(詳細パネルのタグ用)。 */
  groupNamesFor(mask: number): string[] {
    const out: string[] = [];
    for (let bit = 0; bit < this.names.length; bit += 1) {
      if (mask & (1 << bit)) {
        const name = this.names[bit];
        if (name) out.push(name);
      }
    }
    return out;
  }

  /** すべてのグループを表示する状態のフィルタマスク */
  get allMask(): number {
    return this.names.length >= 32 ? -1 : (1 << this.names.length) - 1;
  }

  /** CelesTrak のどのグループにも載っていない衛星か */
  isUngrouped(mask: number): boolean {
    return (mask & this.ungroupedFlag) !== 0;
  }

  /**
   * 表示カテゴリを決める。グループ所属があればそれを優先し、
   * どこにも属さない衛星だけ軌道形状から振り分ける。
   */
  categoryFor(mask: number, meanMotionRevPerDay: number, eccentricity: number): Category {
    for (const { flag, category } of this.priority) {
      if (mask & flag) return category;
    }
    return orbitRegime(meanMotionRevPerDay, eccentricity);
  }
}

/**
 * 軌道形状だけからの分類(グループ未収載の衛星向けフォールバック)。
 * @param meanMotion 1 日あたりの周回数
 */
export function orbitRegime(meanMotion: number, eccentricity: number): Category {
  if (!Number.isFinite(meanMotion) || meanMotion <= 0) return Category.Leo;
  // 静止軌道は 1 恒星日で 1 周 = 1.0027 rev/day
  if (Math.abs(meanMotion - 1.0027) < 0.02 && eccentricity < 0.02) return Category.Geo;
  if (eccentricity > 0.25) return Category.Heo;
  const periodHours = 24 / meanMotion;
  if (periodHours >= 2 && periodHours <= 20) return Category.Meo;
  return Category.Leo;
}
