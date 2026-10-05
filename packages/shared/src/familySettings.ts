import type { Visibility } from './enums';

/**
 * 家庭设置中支持「变更预览 + 乐观并发合并」的字段集合。
 * 注意：只有这里列出的字段参与版本合并；name/description 不与默认可见性、
 * 留言开关混在同一个合并口径里（见 mergeFamilySettings）。
 */
export const FAMILY_SETTING_FIELDS = ['defaultVisibility', 'allowViewerComment'] as const;
export type FamilySettingField = (typeof FAMILY_SETTING_FIELDS)[number];

export interface FamilySettings {
  defaultVisibility: Visibility;
  allowViewerComment: boolean;
}

export type FamilySettingsUpdate = Partial<FamilySettings>;

export interface ChangedField {
  field: FamilySettingField;
  before: string | boolean;
  after: string | boolean;
}

/**
 * 计算一次设置提交相对某个基线快照改了哪些字段。
 * 预览页与保存后的审计都用它，保证「预览看到的变更」和「实际落库的变更」口径一致。
 */
export function familySettingChanges(base: FamilySettings, next: FamilySettingsUpdate): ChangedField[] {
  const changes: ChangedField[] = [];
  for (const field of FAMILY_SETTING_FIELDS) {
    const value = next[field];
    if (value === undefined) continue;
    if (value !== base[field]) {
      changes.push({ field, before: base[field], after: value });
    }
  }
  return changes;
}

export type FamilySettingsMergeOutcome =
  | { outcome: 'clean'; changes: ChangedField[]; merged: FamilySettings }
  | {
      outcome: 'conflict';
      changes: ChangedField[];
      conflicts: ChangedField[];
      merged: FamilySettings;
      current: FamilySettings;
    };

/**
 * 家庭设置的三方合并（base：编辑者打开页面时的版本；next：编辑者提交的内容；
 * current：当前库里的最新值）。
 *
 * 合并规则（历史口径不能错乱的关键所在）：
 * - 编辑者没有动过的字段（base === next），一律保持 current，不覆盖其他管理员的改动；
 * - 编辑者改过且其他管理员没动过的字段（base === current），采用编辑者的值；
 * - 双方都改过但改成同一个值，视为一致而非冲突；
 * - 双方改成不同值才记为冲突，由调用方返回 409 让管理员人工选择。
 *
 * 这些开关只影响「之后新建的条目 / 之后新留的言」，合并本身不触碰任何历史条目，
 * 因此这里不做、也不允许做任何历史数据迁移。
 */
export function mergeFamilySettings(
  base: FamilySettings,
  next: FamilySettingsUpdate,
  current: FamilySettings,
): FamilySettingsMergeOutcome {
  const merged: FamilySettings = { ...current };
  const changes: ChangedField[] = [];
  const conflicts: ChangedField[] = [];

  const assign = (field: FamilySettingField, value: string | boolean) => {
    (merged as unknown as Record<string, string | boolean>)[field] = value;
  };

  for (const field of FAMILY_SETTING_FIELDS) {
    const desired = next[field] as FamilySettings[FamilySettingField] | undefined;
    if (desired === undefined) continue; // 该字段不在本次提交范围
    assign(field, desired);
    if (desired === base[field]) {
      // 编辑者没动过这个字段：保留其他管理员已经写入的 current 值
      assign(field, current[field] as string | boolean);
      continue;
    }
    changes.push({ field, before: base[field] as string | boolean, after: desired as string | boolean });
    if (current[field] === base[field]) continue; // 只有一方改了，直接采用
    if (current[field] === desired) {
      // 双方改成同一个值，最终状态一致，不算冲突
      continue;
    }
    conflicts.push({ field, before: base[field] as string | boolean, after: desired as string | boolean });
  }

  if (conflicts.length > 0) {
    return { outcome: 'conflict', changes, conflicts, merged, current };
  }
  return { outcome: 'clean', changes, merged };
}

/** 旧客户端没带 expectedVersion 时不允许写入，避免静默覆盖其他管理员的设置。 */
export const SETTINGS_VERSION_REQUIRED = 'settings_version_required';
/** 版本落后且存在字段级冲突，需要管理员人工取舍。 */
export const SETTINGS_VERSION_CONFLICT = 'settings_version_conflict';
