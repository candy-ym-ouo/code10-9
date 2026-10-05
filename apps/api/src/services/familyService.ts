import type { Family, FamilyRole, Prisma } from '@prisma/client';
import {
  canAssignRole,
  canManageMember,
  mergeFamilySettings,
  normalizeFamilyPatch,
  previewFamilySettings,
  type FamilySettingKey,
  type FamilySettings,
} from '@heirloom/shared';
import { prisma } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { randomToken, sha256Hex } from '../utils/crypto';
import * as audit from './auditService';
import { toMemberDto } from '../serializers';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export const familyDetailInclude = {
  _count: { select: { members: true, items: true, people: true } },
} satisfies Prisma.FamilyInclude;

/** Family 行 → 对外的设置 DTO（含乐观锁版本号）。 */
export function toFamilySettingsDto(family: Family) {
  return {
    id: family.id,
    name: family.name,
    description: family.description,
    defaultVisibility: family.defaultVisibility,
    allowViewerComment: family.allowViewerComment,
    settingsVersion: family.settingsVersion,
    createdAt: family.createdAt.toISOString(),
  };
}

function settingsOf(family: Family): FamilySettings {
  return {
    name: family.name,
    description: family.description,
    allowViewerComment: family.allowViewerComment,
    defaultVisibility: family.defaultVisibility,
  };
}

export interface FamilyUpdateInput {
  name?: string;
  description?: string | null;
  defaultVisibility?: Family['defaultVisibility'];
  allowViewerComment?: boolean;
  expectedVersion?: number;
  base?: FamilySettings;
}

export interface FamilyUpdateResult {
  family: Family;
  changes: { key: FamilySettingKey; before: string | boolean | null; after: string | boolean | null }[];
  conflicts: { key: FamilySettingKey; yours: string | boolean | null; theirs: string | boolean | null }[];
  stale: boolean;
  merged: boolean;
  noop: boolean;
}

export async function createFamily(
  userId: string,
  input: { name: string; description?: string | null; defaultVisibility?: 'private' | 'family' | 'selected' | 'link' },
  meta: ActorMeta,
) {
  return prisma.$transaction(async (tx) => {
    const family = await tx.family.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        defaultVisibility: input.defaultVisibility ?? 'family',
        createdBy: userId,
      },
    });
    await tx.familyMember.create({ data: { familyId: family.id, userId, role: 'owner' } });
    await audit.record(
      {
        familyId: family.id,
        actorId: userId,
        action: 'family.create',
        targetType: 'family',
        targetId: family.id,
        diff: { name: family.name } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return family;
  });
}

export async function getFamilyDetail(familyId: string) {
  const family = await prisma.family.findFirst({
    where: { id: familyId, deletedAt: null },
    include: familyDetailInclude,
  });
  if (!family) throw notFound('家庭不存在');
  return family;
}

/**
 * 更新家庭设置。
 *
 * 携带 expectedVersion + base 时走三路合并（多管理员并发安全）：
 *   1. 事务内读到的 current 是合并基准，审计 diff 也以它为准（不会拿事务外的旧行算历史）；
 *   2. 互不相交的字段自动合并、版本推进；同字段改出不同值则整笔 409，不做部分写入；
 *   3. 条件 UPDATE（settings_version = 读到的版本）兜住两个事务同时提交，撞车后重试。
 * 不携带版本时保留旧客户端的整行覆盖语义。
 */
export async function updateFamily(
  actorId: string,
  familyId: string,
  input: FamilyUpdateInput,
  meta: ActorMeta,
): Promise<FamilyUpdateResult> {
  const useMerge = input.expectedVersion !== undefined && input.base !== undefined;

  if (!useMerge) {
    return updateFamilyLegacy(actorId, familyId, input, meta);
  }

  const expectedVersion = input.expectedVersion!;
  const base = input.base!;
  const patch = normalizeFamilyPatch({
    name: input.name,
    description: input.description,
    defaultVisibility: input.defaultVisibility,
    allowViewerComment: input.allowViewerComment,
  });

  // 条件更新撞车（另一个事务刚刚提交）时，拿最新行重新合并若干次
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.family.findFirst({ where: { id: familyId, deletedAt: null } });
      if (!current) throw notFound('家庭不存在');

      const merged = mergeFamilySettings({
        base,
        current: settingsOf(current),
        patch,
        expectedVersion,
        currentVersion: current.settingsVersion,
      });

      if (merged.conflicts.length > 0) {
        throw conflict('设置已被其他管理员修改，部分字段存在冲突，请刷新后重试', {
          code: 'FAMILY_SETTINGS_CONFLICT',
          settingsVersion: current.settingsVersion,
          current: toFamilySettingsDto(current),
          conflicts: merged.conflicts,
        });
      }

      if (merged.changes.length === 0) {
        return {
          family: current,
          changes: [],
          conflicts: [],
          stale: merged.stale,
          merged: merged.stale,
          noop: true,
        };
      }

      // 以事务内读到的版本为条件：并发提交时只会有一个事务成功
      const bumped = await tx.family.updateMany({
        where: { id: familyId, deletedAt: null, settingsVersion: current.settingsVersion },
        data: {
          name: merged.settings.name,
          description: merged.settings.description,
          defaultVisibility: merged.settings.defaultVisibility,
          allowViewerComment: merged.settings.allowViewerComment,
          settingsVersion: { increment: 1 },
        },
      });
      if (bumped.count === 0) return null; // 版本被并发推进，外层重试

      const updated = await tx.family.findUniqueOrThrow({ where: { id: familyId } });

      // 审计口径：before 是事务内读到的真实旧值，after 是真实新值，只记本次落库字段
      await audit.record(
        {
          familyId,
          actorId,
          action: 'family.update',
          targetType: 'family',
          targetId: familyId,
          diff: {
            fields: merged.changes.map((c) => c.key),
            before: Object.fromEntries(merged.changes.map((c) => [c.key, c.before])),
            after: Object.fromEntries(merged.changes.map((c) => [c.key, c.after])),
          } as Prisma.InputJsonValue,
          ...meta,
        },
        tx,
      );

      return {
        family: updated,
        changes: merged.changes,
        conflicts: [],
        stale: merged.stale,
        merged: merged.stale,
        noop: false,
      };
    });

    if (result !== null) return result;
  }

  throw conflict('设置并发冲突，重试后仍未合并成功，请刷新页面后重试');
}

/** 旧客户端路径：不带版本号，整行覆盖；审计仍在事务内按真实新旧值计算。 */
async function updateFamilyLegacy(
  actorId: string,
  familyId: string,
  input: FamilyUpdateInput,
  meta: ActorMeta,
): Promise<FamilyUpdateResult> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.family.findFirst({ where: { id: familyId, deletedAt: null } });
    if (!before) throw notFound('家庭不存在');

    const data = {
      name: input.name ?? undefined,
      description: input.description === undefined ? undefined : input.description,
      defaultVisibility: input.defaultVisibility ?? undefined,
      allowViewerComment: input.allowViewerComment ?? undefined,
    };
    const updated = await tx.family.update({ where: { id: familyId }, data });

    const diffBefore: Record<string, unknown> = {};
    const diffAfter: Record<string, unknown> = {};
    const fields: FamilySettingKey[] = [];
    for (const key of ['name', 'description', 'defaultVisibility', 'allowViewerComment'] as const) {
      const b = before[key];
      const a = updated[key];
      if (a !== undefined && b !== a) {
        diffBefore[key] = b;
        diffAfter[key] = a;
        fields.push(key);
      }
    }

    if (fields.length > 0) {
      await audit.record(
        {
          familyId,
          actorId,
          action: 'family.update',
          targetType: 'family',
          targetId: familyId,
          diff: { fields, before: diffBefore, after: diffAfter } as Prisma.InputJsonValue,
          ...meta,
        },
        tx,
      );
    }

    return {
      family: updated,
      changes: fields.map((key) => ({ key, before: diffBefore[key] as never, after: diffAfter[key] as never })),
      conflicts: [],
      stale: false,
      merged: false,
      noop: fields.length === 0,
    };
  });
}

/**
 * 保存前预览：不落库，复用保存时的同一套合并逻辑，
 * 保证「预览看到的变化」和「真正保存的结果」是同一口径。
 */
export async function previewSettings(
  familyId: string,
  input: { expectedVersion: number; base: FamilySettings; patch: Partial<FamilySettings> },
) {
  const current = await prisma.family.findFirst({ where: { id: familyId, deletedAt: null } });
  if (!current) throw notFound('家庭不存在');
  return previewFamilySettings({
    base: input.base,
    current: settingsOf(current),
    patch: input.patch,
    expectedVersion: input.expectedVersion,
    currentVersion: current.settingsVersion,
  });
}

export async function deleteFamily(actorId: string, familyId: string, confirmName: string, meta: ActorMeta) {
  const family = await getFamilyDetail(familyId);
  if (family.name !== confirmName) throw badRequest('家庭名不匹配，删除已取消');
  await prisma.$transaction(async (tx) => {
    await tx.family.update({ where: { id: familyId }, data: { deletedAt: new Date() } });
    await audit.record(
      { familyId, actorId, action: 'family.delete', targetType: 'family', targetId: familyId, ...meta },
      tx,
    );
  });
}

export async function listMembers(familyId: string, includeDisabled = false) {
  const members = await prisma.familyMember.findMany({
    where: { familyId, status: includeDisabled ? undefined : 'active' },
    include: { user: { select: { id: true, email: true, displayName: true, avatarColor: true } } },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
  });
  return members.map(toMemberDto);
}

export async function updateMemberRole(
  actor: { id: string; role: FamilyRole },
  familyId: string,
  targetUserId: string,
  role: FamilyRole,
  meta: ActorMeta,
) {
  const target = await prisma.familyMember.findUnique({
    where: { familyId_userId: { familyId, userId: targetUserId } },
  });
  if (!target) throw notFound('成员不存在');
  if (!canManageMember(actor.role, target.role)) throw forbidden('你不能修改该成员的权限');
  if (!canAssignRole(actor.role, role)) throw forbidden('你不能授予该角色');
  if (target.role === 'owner') throw forbidden('不能修改家庭创建者的角色');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.familyMember.update({
      where: { familyId_userId: { familyId, userId: targetUserId } },
      data: { role, status: 'active' },
    });
    await audit.record(
      {
        familyId,
        actorId: actor.id,
        action: 'member.update_role',
        targetType: 'user',
        targetId: targetUserId,
        diff: audit.diffOf({ role: target.role, status: target.status }, { role, status: 'active' }),
        ...meta,
      },
      tx,
    );
    return updated;
  });
}

export async function setMemberStatus(
  actor: { id: string; role: FamilyRole },
  familyId: string,
  targetUserId: string,
  status: 'active' | 'disabled',
  meta: ActorMeta,
) {
  const target = await prisma.familyMember.findUnique({
    where: { familyId_userId: { familyId, userId: targetUserId } },
  });
  if (!target) throw notFound('成员不存在');
  if (!canManageMember(actor.role, target.role)) throw forbidden('你不能修改该成员的状态');

  await prisma.$transaction(async (tx) => {
    await tx.familyMember.update({
      where: { familyId_userId: { familyId, userId: targetUserId } },
      data: { status },
    });
    if (status === 'disabled') {
      await tx.refreshToken.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await audit.record(
      {
        familyId,
        actorId: actor.id,
        action: 'member.update_role',
        targetType: 'user',
        targetId: targetUserId,
        diff: audit.diffOf({ status: target.status }, { status }),
        ...meta,
      },
      tx,
    );
  });
}

export async function removeMember(
  actor: { id: string; role: FamilyRole },
  familyId: string,
  targetUserId: string,
  meta: ActorMeta,
) {
  const target = await prisma.familyMember.findUnique({
    where: { familyId_userId: { familyId, userId: targetUserId } },
  });
  if (!target) throw notFound('成员不存在');
  if (!canManageMember(actor.role, target.role)) throw forbidden('你不能移除该成员');

  await prisma.$transaction(async (tx) => {
    await tx.familyMember.delete({ where: { familyId_userId: { familyId, userId: targetUserId } } });
    // 清掉该成员在这个家庭里的条目级授权，避免残留
    await tx.itemShare.deleteMany({ where: { userId: targetUserId, item: { familyId } } });
    // 会话与家庭无关，直接撤销该用户全部登录态，保证被移除后立即失效
    await tx.refreshToken.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit.record(
      {
        familyId,
        actorId: actor.id,
        action: 'member.remove',
        targetType: 'user',
        targetId: targetUserId,
        diff: { role: target.role } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });
}

export async function createInvite(
  actorId: string,
  actorRole: FamilyRole,
  familyId: string,
  input: { role: FamilyRole; expiresInDays: number; maxUses: number; note?: string | null },
  meta: ActorMeta,
) {
  if (!canAssignRole(actorRole, input.role)) throw forbidden('你不能邀请为该角色');
  const code = randomToken(18);
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);

  const invite = await prisma.$transaction(async (tx) => {
    const created = await tx.invite.create({
      data: {
        familyId,
        codeHash: sha256Hex(code),
        role: input.role,
        note: input.note ?? null,
        expiresAt,
        maxUses: input.maxUses,
        createdBy: actorId,
      },
    });
    await audit.record(
      {
        familyId,
        actorId,
        action: 'member.invite',
        targetType: 'invite',
        targetId: created.id,
        diff: { role: input.role, maxUses: input.maxUses } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return created;
  });

  // 明文只在这里返回一次，库里只有 hash
  return { ...invite, code };
}

export async function listInvites(familyId: string) {
  return prisma.invite.findMany({ where: { familyId }, orderBy: { createdAt: 'desc' }, take: 100 });
}

export async function revokeInvite(actorId: string, familyId: string, inviteId: string, meta: ActorMeta) {
  const invite = await prisma.invite.findFirst({ where: { id: inviteId, familyId } });
  if (!invite) throw notFound('邀请不存在');
  await prisma.$transaction(async (tx) => {
    await tx.invite.update({ where: { id: inviteId }, data: { revokedAt: new Date() } });
    await audit.record(
      { familyId, actorId, action: 'member.invite', targetType: 'invite', targetId: inviteId, diff: { revoked: true } as Prisma.InputJsonValue, ...meta },
      tx,
    );
  });
}

export async function previewInvite(code: string) {
  const invite = await prisma.invite.findUnique({
    where: { codeHash: sha256Hex(code) },
    include: { family: { select: { id: true, name: true, description: true } } },
  });
  if (!invite) throw notFound('邀请链接无效');
  if (invite.revokedAt) throw conflict('邀请已被撤销');
  if (invite.expiresAt.getTime() < Date.now()) throw conflict('邀请已过期');
  if (invite.usedCount >= invite.maxUses) throw conflict('邀请使用次数已用尽');
  return {
    familyId: invite.familyId,
    familyName: invite.family.name,
    familyDescription: invite.family.description,
    role: invite.role,
    expiresAt: invite.expiresAt.toISOString(),
    remainingUses: invite.maxUses - invite.usedCount,
  };
}

export async function acceptInvite(userId: string, code: string, meta: ActorMeta) {
  const invite = await prisma.invite.findUnique({ where: { codeHash: sha256Hex(code) } });
  if (!invite) throw notFound('邀请链接无效');
  if (invite.revokedAt) throw conflict('邀请已被撤销');
  if (invite.expiresAt.getTime() < Date.now()) throw conflict('邀请已过期');
  if (invite.usedCount >= invite.maxUses) throw conflict('邀请使用次数已用尽');

  const existing = await prisma.familyMember.findUnique({
    where: { familyId_userId: { familyId: invite.familyId, userId } },
  });
  if (existing) {
    return { familyId: invite.familyId, role: existing.role, alreadyMember: true };
  }

  return prisma.$transaction(async (tx) => {
    // 条件更新兜住并发：只有 used_count < max_uses 时才 +1
    const bumped = await tx.invite.updateMany({
      where: { id: invite.id, usedCount: { lt: invite.maxUses }, revokedAt: null },
      data: { usedCount: { increment: 1 } },
    });
    if (bumped.count === 0) throw conflict('邀请使用次数已用尽');

    await tx.familyMember.create({
      data: { familyId: invite.familyId, userId, role: invite.role },
    });
    await audit.record(
      {
        familyId: invite.familyId,
        actorId: userId,
        action: 'member.join',
        targetType: 'user',
        targetId: userId,
        diff: { role: invite.role } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return { familyId: invite.familyId, role: invite.role, alreadyMember: false };
  });
}

