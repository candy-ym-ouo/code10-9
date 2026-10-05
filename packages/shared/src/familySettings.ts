import { VISIBILITY_LABELS } from './enums';

/**
 * 家庭设置的并发合并与变更预览。
 *
 * 背景：owner/admin 可以同时打开设置页保存。直接「整行覆盖」会把对方刚改的字段
 * 悄悄改回去，而且审计 diff 是按事务外读到的旧行算的，历史口径会错乱。
 *
 * 这里收敛为唯一的纯函数实现，服务端保存、服务端预览接口、前端预览面板共用同一份口径：
 *   base   —— 本次编辑开始时看到的设置（携带对应的 settingsVersion）
 *   current —— 现在数据库里的设置（可能已被另一位管理员改过）
 *   patch  —— 本次想改成的样子
 *
 * 合并规则（字段级三路合并）：
 *   - 本次没动的字段：一律保留 current（别人改了也采纳）；
 *   - 本次动了、别人没动（current[key] === base[key]）：应用本次修改；
 *   - 本次动了、别人也动了（current[key] !== base[key]）且两边目标值不同：冲突，拒绝整笔保存；
 *   - 两边都改成同一个值：不算冲突，幂等成功。
 */

export const FAMILY_SETTING_KEYS = [
  'name',
  'description',
  'defaultVisibility',
  'allowViewerComment',
] as const;
export type FamilySettingKey = (typeof FAMILY_SETTING_KEYS)[number];

export type FamilyVisibility = 'private' | 'family' | 'selected' | 'link';

export interface FamilySettings {
  name: string;
  description: string | null;
  defaultVisibility: FamilyVisibility;
  allowViewerComment: boolean;
}

/** 本次保存里允许出现的字段（全部可选；服务端不允许把设置改没）。 */
export type FamilySettingsPatch = Partial<FamilySettings>;

export interface FamilySettingChange {
  key: FamilySettingKey;
  /** base → 本次保存后真正落库的值 */
  before: string | boolean | null;
  after: string | boolean | null;
}

export interface FamilySettingConflict {
  key: FamilySettingKey;
  /** 自己想改成的值 */
  yours: string | boolean | null;
  /** 另一位管理员已经改成的值（current） */
  theirs: string | boolean | null;
}

export interface FamilySettingsMergeResult {
  /** 合并后应落库的完整设置 */
  settings: FamilySettings;
  /** 本次真正写入的字段（相对事务内读到的 current），审计只记这些 */
  changes: FamilySettingChange[];
  /** 与别的管理员修改撞车、无法自动合并的字段；非空时必须拒绝保存 */
  conflicts: FamilySettingConflict[];
  /**
   * 版本已被别人推进（current.version !== expectedVersion）：
   * - 全部字段都能自动合并时仍保存成功，调用方可提示「已合并管理员 X 的修改」；
   * - conflicts 非空时则整体 409。
   */
  stale: boolean;
  /** 合并后没有任何字段需要写入 */
  noop: boolean;
}

type Primitive = string | boolean | null;

function sameValue(a: Primitive, b: Primitive): boolean {
  return a === b;
}

/** 入参归一化：名称去空白；说明空串落 null（与建家庭时的口径一致）。 */
export function normalizeFamilyPatch(patch: FamilySettingsPatch): FamilySettingsPatch {
  const out: FamilySettingsPatch = {};
  if (patch.name !== undefined) out.name = patch.name.trim();
  if (patch.description !== undefined) {
    const trimmedDesc = patch.description?.trim() ?? '';
    out.description = trimmedDesc === '' ? null : trimmedDesc;
  }
  if (patch.defaultVisibility !== undefined) out.defaultVisibility = patch.defaultVisibility;
  if (patch.allowViewerComment !== undefined) out.allowViewerComment = patch.allowViewerComment;
  return out;
}

export interface MergeFamilySettingsInput {
  base: FamilySettings;
  current: FamilySettings;
  patch: FamilySettingsPatch;
  /** 编辑开始时看到的 settingsVersion */
  expectedVersion: number;
  /** 现在库里的 settingsVersion */
  currentVersion: number;
}

export function mergeFamilySettings(input: MergeFamilySettingsInput): FamilySettingsMergeResult {
  const patch = normalizeFamilyPatch(input.patch);
  const { base, current } = input;
  const stale = input.currentVersion !== input.expectedVersion;

  const settings: FamilySettings = { ...current };
  const changes: FamilySettingChange[] = [];
  const conflicts: FamilySettingConflict[] = [];

  for (const key of FAMILY_SETTING_KEYS) {
    if (!(key in patch)) continue;
    const want = patch[key] as Primitive;
    const startedWith = base[key] as Primitive;
    const theyHave = current[key] as Primitive;

    const clientChanged = !sameValue(startedWith, want);
    const otherChanged = stale && !sameValue(theyHave, startedWith);

    if (otherChanged && clientChanged && !sameValue(want, theyHave)) {
      // 两边都改了同一字段，且目标值不一致：无法自动合并
      conflicts.push({ key, yours: want, theirs: theyHave });
      continue;
    }

    if (!sameValue(theyHave, want)) {
      // 别人没动这个字段（或双方改成了同一个值），应用本次修改
      settings[key] = want as never;
      changes.push({ key, before: theyHave, after: want });
    }
  }

  return { settings, changes, conflicts, stale, noop: changes.length === 0 && conflicts.length === 0 };
}

/* ---------------------------------- 展示口径 ---------------------------------- */

export const FAMILY_SETTING_LABELS: Record<FamilySettingKey, string> = {
  name: '家庭名称',
  description: '说明',
  defaultVisibility: '新建条目的默认可见范围',
  allowViewerComment: '允许只读成员留言',
};

/**
 * 变更预览里每个字段附带的影响说明。重点回答「历史条目口径会不会变」：
 * 默认可见性与留言开关都只影响「之后」的行为，不会回溯改动已有条目。
 */
export const FAMILY_SETTING_HINTS: Record<FamilySettingKey, string> = {
  name: '家庭名称会显示在顶部与成员列表中。',
  description: '说明展示在家庭首页，不影响任何已有条目。',
  defaultVisibility: '只对之后新建的条目生效；已有条目的可见范围保持原样，不会被批量改写。',
  allowViewerComment: '开启后，只读成员可以在「已发布」的条目下补充故事/留言；关闭后新留言会被拦截，已经提交的留言不受影响。',
};

export function formatFamilySettingValue(key: FamilySettingKey, value: Primitive): string {
  if (key === 'defaultVisibility') {
    return VISIBILITY_LABELS[(value as FamilyVisibility) ?? 'family'] ?? String(value);
  }
  if (key === 'allowViewerComment') return value ? '允许留言' : '不允许留言';
  if (value === null || value === '') return '（空）';
  return String(value);
}

export interface FamilySettingsPreview extends FamilySettingsMergeResult {
  /** 给界面直接渲染的变更条目 */
  changeLines: {
    key: FamilySettingKey;
    label: string;
    before: string;
    after: string;
    hint: string;
  }[];
  conflictLines: {
    key: FamilySettingKey;
    label: string;
    yours: string;
    theirs: string;
  }[];
}

/**
 * 变更预览：保存前看到「会改什么、影响什么、和谁撞了车」。
 * 与保存走同一个 mergeFamilySettings，保证预览结果与实际落库严格一致。
 */
export function previewFamilySettings(input: MergeFamilySettingsInput): FamilySettingsPreview {
  const merged = mergeFamilySettings(input);
  return {
    ...merged,
    changeLines: merged.changes.map((c) => ({
      key: c.key,
      label: FAMILY_SETTING_LABELS[c.key],
      before: formatFamilySettingValue(c.key, c.before),
      after: formatFamilySettingValue(c.key, c.after),
      hint: FAMILY_SETTING_HINTS[c.key],
    })),
    conflictLines: merged.conflicts.map((c) => ({
      key: c.key,
      label: FAMILY_SETTING_LABELS[c.key],
      yours: formatFamilySettingValue(c.key, c.yours),
      theirs: formatFamilySettingValue(c.key, c.theirs),
    })),
  };
}
