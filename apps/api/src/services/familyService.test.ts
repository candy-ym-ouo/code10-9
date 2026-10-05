import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Family } from '@prisma/client';

// 用内存表模拟 Prisma 事务客户端，专门验证家庭设置的并发合并/重试/审计口径
type FamilyRow = Family;

const store = new Map<string, FamilyRow>();
const audits: unknown[] = [];

interface UpdateManyArgs {
  where: { id: string; deletedAt: null; settingsVersion: number };
  data: Partial<FamilyRow>;
}

function applyData(row: FamilyRow, data: Partial<FamilyRow>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) {
      (row as Record<string, unknown>)[key] = (row as Record<string, number>)[key] + (value as { increment: number }).increment;
    } else {
      (row as Record<string, unknown>)[key] = value;
    }
  }
}

function makeTx() {
  return {
    family: {
      // 真实 Prisma 返回的是独立对象；这里也给快照，保证「旧值」不会被后续更新原地改掉
      findFirst: vi.fn(async (args: { where: { id: string; deletedAt: null } }) => {
        const row = store.get(args.where.id);
        return row && !row.deletedAt ? ({ ...row }) : null;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<FamilyRow> }) => {
        const row = store.get(args.where.id)!;
        applyData(row, args.data);
        return { ...row };
      }),
      updateMany: vi.fn(async (args: UpdateManyArgs) => {
        const row = store.get(args.where.id);
        if (!row || row.settingsVersion !== args.where.settingsVersion || row.deletedAt) return { count: 0 };
        applyData(row, args.data);
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(async (args: { where: { id: string } }) => ({ ...store.get(args.where.id)! })),
    },
    auditLog: {
      create: vi.fn(async (args: { data: unknown }) => {
        audits.push(args.data);
        return { id: `a${audits.length}` };
      }),
    },
  };
}

type Tx = ReturnType<typeof makeTx>;

vi.mock('../db', () => ({
  prisma: {
    // 每次 $transaction 都拿「当下」的 store 状态构建客户端，模拟新事务读到最新已提交行
    $transaction: (fn: (t: Tx) => Promise<unknown>) => fn(makeTx()),
  },
}));

import { updateFamily } from './familyService';
import { prisma } from '../db';

const FID = 'f1';
const makeBase = (): FamilyRow => ({
  id: FID,
  name: '张家',
  description: '记录',
  defaultVisibility: 'family',
  allowViewerComment: false,
  settingsVersion: 1,
  createdBy: 'u1',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  deletedAt: null,
});

const baseSnapshot = {
  name: '张家',
  description: '记录',
  defaultVisibility: 'family' as const,
  allowViewerComment: false,
};

beforeEach(() => {
  audits.length = 0;
  store.clear();
  store.set(FID, makeBase());
  vi.restoreAllMocks();
});

describe('updateFamily 并发合并', () => {
  it('同版本保存：写入、版本 +1、审计只记变化字段（含留言开关）', async () => {
    const res = await updateFamily(
      'u2',
      FID,
      {
        expectedVersion: 1,
        base: baseSnapshot,
        defaultVisibility: 'private',
        allowViewerComment: true,
      },
      {},
    );
    expect(res.family.settingsVersion).toBe(2);
    expect(res.changes.map((c) => c.key)).toEqual(['defaultVisibility', 'allowViewerComment']);
    expect(audits).toHaveLength(1);
    const diff = (audits[0] as { diff: { fields: string[] } }).diff;
    expect(diff.fields).toEqual(['defaultVisibility', 'allowViewerComment']);
  });

  it('并发改不相交字段：自动合并、保留对方字段、版本继续 +1', async () => {
    // 管理员 A 已把名称改掉并推进到 v2
    store.set(FID, { ...makeBase(), name: '李家', settingsVersion: 2 });
    const res = await updateFamily(
      'u2',
      FID,
      { expectedVersion: 1, base: baseSnapshot, defaultVisibility: 'link' },
      {},
    );
    expect(res.conflicts).toEqual([]);
    expect(res.merged).toBe(true);
    expect(res.stale).toBe(true);
    expect(res.family.name).toBe('李家');
    expect(res.family.defaultVisibility).toBe('link');
    expect(res.family.settingsVersion).toBe(3);
    expect(audits).toHaveLength(1);
  });

  it('并发改同一字段且值不同：409 冲突，不写入、不记审计', async () => {
    store.set(FID, { ...makeBase(), defaultVisibility: 'private', settingsVersion: 2 });
    await expect(
      updateFamily('u2', FID, { expectedVersion: 1, base: baseSnapshot, defaultVisibility: 'link' }, {}),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(store.get(FID)!.defaultVisibility).toBe('private');
    expect(store.get(FID)!.settingsVersion).toBe(2);
    expect(audits).toHaveLength(0);
  });

  it('条件更新撞车后重试：用最新行重新合并成功', async () => {
    // 第一次事务：读到 v1 后条件更新瞬间版本已变（另一事务提交），count=0 触发重试；
    // 第二次事务读到 v3，且对方改的是不相交字段（名称）→ 合并成功
    let calls = 0;
    vi.spyOn(prisma, '$transaction').mockImplementation((fn: (t: Tx) => Promise<unknown>) => {
      calls += 1;
      const t = makeTx();
      t.family.updateMany.mockImplementation(async (args: UpdateManyArgs) => {
        if (calls === 1) {
          store.set(FID, { ...store.get(FID)!, name: '新家', settingsVersion: 3 });
          return { count: 0 };
        }
        const row = store.get(args.where.id)!;
        applyData(row, args.data);
        return { count: 1 };
      });
      return fn(t);
    });

    const res = await updateFamily(
      'u2',
      FID,
      { expectedVersion: 1, base: baseSnapshot, defaultVisibility: 'selected' },
      {},
    );
    expect(calls).toBe(2);
    expect(res.family.settingsVersion).toBe(4);
    expect(res.family.name).toBe('新家'); // 别人的修改保留
    expect(res.family.defaultVisibility).toBe('selected');
  });

  it('不带版本号的旧客户端：整行覆盖仍可保存，审计按真实变化字段记录', async () => {
    const res = await updateFamily('u2', FID, { allowViewerComment: true }, {});
    expect(res.family.settingsVersion).toBe(1); // 旧路径不推进版本
    expect(res.changes.map((c) => c.key)).toEqual(['allowViewerComment']);
    expect(audits).toHaveLength(1);
  });
});
