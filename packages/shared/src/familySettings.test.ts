import { describe, expect, it } from 'vitest';
import {
  mergeFamilySettings,
  normalizeFamilyPatch,
  previewFamilySettings,
  type FamilySettings,
} from './familySettings';

const current: FamilySettings = {
  name: '张家老物件',
  description: '传家的记录',
  defaultVisibility: 'family',
  allowViewerComment: false,
};

describe('normalizeFamilyPatch', () => {
  it('名称去空白，说明空串归一为 null', () => {
    expect(normalizeFamilyPatch({ name: '  新名字  ', description: '   ' })).toEqual({
      name: '新名字',
      description: null,
    });
    expect(normalizeFamilyPatch({ description: ' 有内容 ' })).toEqual({ description: '有内容' });
    expect(normalizeFamilyPatch({ allowViewerComment: true, defaultVisibility: 'private' })).toEqual({
      allowViewerComment: true,
      defaultVisibility: 'private',
    });
  });
});

describe('mergeFamilySettings', () => {
  it('同版本直接保存：只产出本次真正变化的字段', () => {
    const result = mergeFamilySettings({
      base: current,
      current,
      expectedVersion: 1,
      currentVersion: 1,
      patch: { defaultVisibility: 'private', allowViewerComment: true },
    });
    expect(result.conflicts).toEqual([]);
    expect(result.stale).toBe(false);
    expect(result.noop).toBe(false);
    expect(result.changes.map((c) => c.key)).toEqual(['defaultVisibility', 'allowViewerComment']);
    expect(result.settings.defaultVisibility).toBe('private');
    expect(result.settings.allowViewerComment).toBe(true);
  });

  it('什么都没改时为 noop，不产生审计变更', () => {
    const result = mergeFamilySettings({
      base: current,
      current,
      expectedVersion: 1,
      currentVersion: 1,
      patch: { name: current.name },
    });
    expect(result.noop).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it('并发但改的是互不相交的字段：自动合并，标记 stale', () => {
    // 管理员 A 先把留言开关打开了（current v2）；管理员 B（base 还在 v1）只改默认可见性
    const theirs: FamilySettings = { ...current, allowViewerComment: true };
    const result = mergeFamilySettings({
      base: current,
      current: theirs,
      expectedVersion: 1,
      currentVersion: 2,
      patch: { defaultVisibility: 'link' },
    });
    expect(result.conflicts).toEqual([]);
    expect(result.stale).toBe(true);
    expect(result.changes.map((c) => c.key)).toEqual(['defaultVisibility']);
    // 别人的修改原样保留
    expect(result.settings.allowViewerComment).toBe(true);
    expect(result.settings.defaultVisibility).toBe('link');
  });

  it('并发改了同一字段但目标相同：幂等成功，不算冲突', () => {
    const theirs: FamilySettings = { ...current, allowViewerComment: true };
    const result = mergeFamilySettings({
      base: current,
      current: theirs,
      expectedVersion: 1,
      currentVersion: 2,
      patch: { name: current.name, allowViewerComment: true },
    });
    expect(result.conflicts).toEqual([]);
    expect(result.changes).toEqual([]);
  });

  it('并发改了同一字段且目标不同：返回冲突并给出两边的值', () => {
    const theirs: FamilySettings = { ...current, defaultVisibility: 'private' };
    const result = mergeFamilySettings({
      base: current,
      current: theirs,
      expectedVersion: 1,
      currentVersion: 2,
      patch: { defaultVisibility: 'link', allowViewerComment: true },
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ key: 'defaultVisibility', yours: 'link', theirs: 'private' });
    // 不相交字段仍可算出可落库值，但调用方必须因 conflicts 非空而拒绝整笔保存
    expect(result.changes.map((c) => c.key)).toEqual(['allowViewerComment']);
  });

  it('base 里改过的字段如果这次没提交，别人的新版本直接保留', () => {
    const theirs: FamilySettings = { ...current, name: '李家旧物柜' };
    const result = mergeFamilySettings({
      base: current,
      current: theirs,
      expectedVersion: 1,
      currentVersion: 2,
      patch: { defaultVisibility: 'selected' },
    });
    expect(result.settings.name).toBe('李家旧物柜');
  });
});

describe('previewFamilySettings', () => {
  it('生成可直接渲染的前后值与影响说明，且只影响新条目的口径出现在提示里', () => {
    const preview = previewFamilySettings({
      base: current,
      current,
      expectedVersion: 1,
      currentVersion: 1,
      patch: { defaultVisibility: 'private' },
    });
    expect(preview.changeLines).toHaveLength(1);
    const line = preview.changeLines[0]!;
    expect(line.before).toBe('全家人');
    expect(line.after).toBe('仅自己');
    expect(line.hint).toContain('之后新建');
    expect(line.hint).toContain('已有条目');
  });

  it('布尔开关与空值都有稳定的展示文本', () => {
    const preview = previewFamilySettings({
      base: current,
      current,
      expectedVersion: 1,
      currentVersion: 1,
      patch: { allowViewerComment: true, description: '' },
    });
    const byKey = new Map(preview.changeLines.map((l) => [l.key, l]));
    expect(byKey.get('allowViewerComment')!.after).toBe('允许留言');
    expect(byKey.get('description')!.after).toBe('（空）');
  });

  it('冲突行同时给出双方值，保存端与预览端口径一致', () => {
    const input: Parameters<typeof previewFamilySettings>[0] = {
      base: current,
      current: { ...current, defaultVisibility: 'private' },
      expectedVersion: 1,
      currentVersion: 2,
      patch: { defaultVisibility: 'link' },
    };
    const preview = previewFamilySettings(input);
    expect(preview.conflictLines).toHaveLength(1);
    expect(preview.conflictLines[0]).toMatchObject({ yours: '链接可见', theirs: '仅自己' });
  });
});
