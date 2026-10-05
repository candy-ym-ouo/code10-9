import { describe, expect, it } from 'vitest';
import { familySettingChanges, mergeFamilySettings, type FamilySettings } from './familySettings';

const base: FamilySettings = { defaultVisibility: 'family', allowViewerComment: false };

describe('familySettingChanges 变更口径', () => {
  it('只报告值真正发生变化的字段', () => {
    expect(familySettingChanges(base, { defaultVisibility: 'private', allowViewerComment: false })).toEqual([
      { field: 'defaultVisibility', before: 'family', after: 'private' },
    ]);
  });

  it('没有变化时返回空列表', () => {
    expect(familySettingChanges(base, { defaultVisibility: 'family', allowViewerComment: false })).toEqual([]);
  });

  it('undefined 字段视为本次未提交', () => {
    expect(familySettingChanges(base, { allowViewerComment: true })).toEqual([
      { field: 'allowViewerComment', before: false, after: true },
    ]);
  });
});

describe('mergeFamilySettings 多管理员并发合并', () => {
  it('无并发：直接采用编辑者提交的值', () => {
    const result = mergeFamilySettings(base, { defaultVisibility: 'private' }, base);
    expect(result.outcome).toBe('clean');
    expect(result.merged).toEqual({ defaultVisibility: 'private', allowViewerComment: false });
    expect(result.changes).toHaveLength(1);
  });

  it('编辑者没动的字段被别人改了：保留别人的新值，不覆盖', () => {
    const current: FamilySettings = { defaultVisibility: 'family', allowViewerComment: true };
    const result = mergeFamilySettings(base, { defaultVisibility: 'private' }, current);
    expect(result.outcome).toBe('clean');
    expect(result.merged).toEqual({ defaultVisibility: 'private', allowViewerComment: true });
  });

  it('两个管理员改不同字段：自动合并，互不丢失', () => {
    const current: FamilySettings = { defaultVisibility: 'link', allowViewerComment: false };
    const result = mergeFamilySettings(base, { allowViewerComment: true }, current);
    expect(result.outcome).toBe('clean');
    expect(result.merged).toEqual({ defaultVisibility: 'link', allowViewerComment: true });
  });

  it('双方改同一字段且改成相同值：结果一致，不算冲突', () => {
    const current: FamilySettings = { defaultVisibility: 'private', allowViewerComment: false };
    const result = mergeFamilySettings(base, { defaultVisibility: 'private' }, current);
    expect(result.outcome).toBe('clean');
    expect(result.merged.defaultVisibility).toBe('private');
  });

  it('双方改同一字段成不同值：报告冲突并带回当前值，不静默落库', () => {
    const current: FamilySettings = { defaultVisibility: 'link', allowViewerComment: false };
    const result = mergeFamilySettings(base, { defaultVisibility: 'private' }, current);
    expect(result.outcome).toBe('conflict');
    if (result.outcome !== 'conflict') throw new Error('窄化失败');
    expect(result.conflicts).toEqual([{ field: 'defaultVisibility', before: 'family', after: 'private' }]);
    expect(result.current).toEqual(current);
  });

  it('部分字段可合并、部分冲突：可合并字段仍给出合并结果', () => {
    const current: FamilySettings = { defaultVisibility: 'link', allowViewerComment: true };
    const result = mergeFamilySettings(
      base,
      { defaultVisibility: 'private', allowViewerComment: true },
      current,
    );
    expect(result.outcome).toBe('conflict');
    if (result.outcome !== 'conflict') throw new Error('窄化失败');
    expect(result.conflicts.map((c) => c.field)).toEqual(['defaultVisibility']);
    expect(result.merged.allowViewerComment).toBe(true);
  });

  it('提交空更新：永远干净，且不覆盖别人的改动', () => {
    const current: FamilySettings = { defaultVisibility: 'link', allowViewerComment: true };
    const result = mergeFamilySettings(base, {}, current);
    expect(result.outcome).toBe('clean');
    expect(result.merged).toEqual(current);
  });
});
