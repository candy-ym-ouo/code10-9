import type { Family, FamilyRole, Prisma } from '@prisma/client';
import {
  canAssignRole,
  canManageMember,
  familySettingChanges,
  mergeFamilySettings,
  SETTINGS_VERSION_CONFLICT,
  type FamilySettings,
  type FamilySettingField,
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

export type VisibilityValue = 'private' | 'family' | 'selected' | 'link';

export interface FamilySettingsPatch {
  name?: string;
  description?: string | null;
  defaultVisibility?: VisibilityValue;
  allowViewerComment?: boolean;
  expectedVersion: number;
  base?: {
    name: string;
    description: string | null;
    defaultVisibility: VisibilityValue;
    allowViewerComment: boolean;
  };
}

/** 对外暴露的家庭设置字段（含乐观版本号），与 GET /families/:fid 保持同一口径。 */
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

export const familyDetailInclude = {
  _count: { select: { members: true, items: true, people: true } },
} satisfies Prisma.FamilyInclude;

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

interface ReconciledValues {
  name: string;
  description: string | null;
  defaultVisibility: VisibilityValue;
  allowViewerComment: boolean;
}

interface ConflictField {
  field: FamilySettingField | 'name' | 'description';
  before: unknown;
  after: unknown;
}

/**
 * 一次保存的合并判定。版本一致时直接采用提交值；版本落后时依据 base 做三方合并：
 * 开关字段用 shared 里唯一的 mergeFamilySettings 口径，name/description 在此做同规则判定。
 */
function reconcileSettings(
  before: Family,
  input: FamilySettingsPatch,
): { kind: 'apply'; values: ReconciledValues } | { kind: 'conflict'; conflicts: ConflictField[] } {
  if (before.settingsVersion === input.expectedVersion) {
    return {
      kind: 'apply',
      values: {
        name: input.name ?? before.name,
        description: input.description === undefined ? before.description : input.description,
        defaultVisibility: input.defaultVisibility ?? before.defaultVisibility,
        allowViewerComment: input.allowViewerComment ?? before.allowViewerComment,
      },
    };
  }

  const current: FamilySettings = {
    defaultVisibility: before.defaultVisibility,
    allowViewerComment: before.allowViewerComment,
  };
  const desired: Partial<FamilySettings> = {
    ...(input.defaultVisibility !== undefined ? { defaultVisibility: input.defaultVisibility } : {}),
    ...(input.allowViewerComment !== undefined ? { allowViewerComment: input.allowViewerComment } : {}),
  };

  const conflicts: ConflictField[] = [];
  let merged: FamilySettings = { ...current };

  if (input.base) {
    const result = mergeFamilySettings(
      {
        defaultVisibility: input.base.defaultVisibility,
        allowViewerComment: input.base.allowViewerComment,
      },
      desired,
      current,
    );
    merged = result.merged;
    if (result.outcome === 'conflict') {
      conflicts.push(...result.conflicts.map((c) => ({ field: c.field, before: c.before, after: c.after })));
    }
  } else {
    // 没有 base 快照时无法判断「编辑者是否动过该字段」，版本落后即逐字段视为冲突，
    // 由前端拉到最新值后让管理员显式确认，绝不静默覆盖。
    for (const change of familySettingChanges(current, desired)) {
      conflicts.push({ field: change.field, before: change.before, after: change.after });
    }
  }

  const reconcileText = (
    field: 'name' | 'description',
    desiredValue: string | null | undefined,
    baseValue: string | null | undefined,
    currentValue: string | null,
  ): string | null => {
    if (desiredValue === undefined) return currentValue; // 本次未提交
    if (input.base === undefined) {
      if (desiredValue !== currentValue) {
        conflicts.push({ field, before: currentValue, after: desiredValue });
      }
      return desiredValue;
    }
    if (desiredValue === baseValue) return currentValue; // 编辑者没动，保留别人的修改
    if (currentValue === baseValue || currentValue === desiredValue) return desiredValue;
    conflicts.push({ field, before: baseValue ?? null, after: desiredValue });
    return desiredValue;
  };

  const name = reconcileText('name', input.name, input.base?.name, before.name) ?? before.name;
  const description = reconcileText('description', input.description, input.base?.description, before.description);

  if (conflicts.length > 0) return { kind: 'conflict', conflicts };
  return { kind: 'apply', values: { name, description, ...merged } };
}

const MAX_MERGE_ATTEMPTS = 5;

export async function updateFamily(actorId: string, familyId: string, input: FamilySettingsPatch, meta: ActorMeta) {
  return prisma.$transaction(async (tx) => {
    // 读最新版本 → 合并 → 条件更新（WHERE settings_version = 读到的版本）。
    // 条件更新命中 0 行说明读之后又有别的管理员落库，重新读最新值再合并，直到成功或出现字段冲突。
    for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
      const before = await tx.family.findFirst({ where: { id: familyId, deletedAt: null } });
      if (!before) throw notFound('家庭不存在');

      const decision = reconcileSettings(before, input);
      if (decision.kind === 'conflict') {
        throw conflict('家庭设置已被其他管理员修改，请核对后再保存', {
          reason: SETTINGS_VERSION_CONFLICT,
          currentVersion: before.settingsVersion,
          current: toFamilySettingsDto(before),
          conflicts: decision.conflicts,
        });
      }

      const values = decision.values;
      const touched =
        values.name !== before.name ||
        values.description !== before.description ||
        values.defaultVisibility !== before.defaultVisibility ||
        values.allowViewerComment !== before.allowViewerComment;

      if (!touched) {
        // 合并后没有任何净变化：不推进版本，也不写审计，避免把并发重试误记成一次修改。
        return before;
      }

      const locked = await tx.family.updateMany({
        where: { id: familyId, settingsVersion: before.settingsVersion, deletedAt: null },
        data: {
          name: values.name,
          description: values.description,
          defaultVisibility: values.defaultVisibility,
          allowViewerComment: values.allowViewerComment,
          settingsVersion: { increment: 1 },
        },
      });
      if (locked.count === 0) continue; // 版本刚被推进，带着同一 base 重新合并

      const updated = await tx.family.findUniqueOrThrow({ where: { id: familyId } });
      await audit.record(
        {
          familyId,
          actorId,
          action: 'family.update',
          targetType: 'family',
          targetId: familyId,
          diff: audit.diffOf(
            {
              name: before.name,
              description: before.description,
              defaultVisibility: before.defaultVisibility,
              allowViewerComment: before.allowViewerComment,
              settingsVersion: before.settingsVersion,
            },
            {
              name: updated.name,
              description: updated.description,
              defaultVisibility: updated.defaultVisibility,
              allowViewerComment: updated.allowViewerComment,
              settingsVersion: updated.settingsVersion,
            },
          ),
          ...meta,
        },
        tx,
      );
      return updated;
    }
    throw conflict('家庭设置正被多位管理员同时保存，请刷新后重试', { reason: SETTINGS_VERSION_CONFLICT });
  });
}

/**
 * 设置变更预览：纯计算，绝不落库。
 * 返回字段差异与影响面统计。默认可见性只决定「之后新建、且创建者未显式选择可见范围」
 * 的条目；留言开关只决定 viewer 之后能否新留言——历史条目的可见性与已有留言一律不迁移、
 * 不改写，口径永远以条目 / 留言自身的记录为准。
 */
export async function previewSettings(
  familyId: string,
  input: { defaultVisibility?: VisibilityValue; allowViewerComment?: boolean },
) {
  const family = await getFamilyDetail(familyId);
  const baseSettings: FamilySettings = {
    defaultVisibility: family.defaultVisibility,
    allowViewerComment: family.allowViewerComment,
  };
  const next: Partial<FamilySettings> = {
    ...(input.defaultVisibility !== undefined ? { defaultVisibility: input.defaultVisibility } : {}),
    ...(input.allowViewerComment !== undefined ? { allowViewerComment: input.allowViewerComment } : {}),
  };
  const changes = familySettingChanges(baseSettings, next);

  const [visibilityGroups, viewerCount, viewerNotes, publishedItems] = await Promise.all([
    prisma.item.groupBy({
      by: ['visibility'],
      where: { familyId, deletedAt: null, status: { not: 'trashed' } },
      _count: true,
    }),
    prisma.familyMember.count({ where: { familyId, role: 'viewer', status: 'active' } }),
    // 作者当前角色为 viewer 的历史留言数。角色本身没有历史表，这是唯一可统计的口径，
    // 仅用于在预览里说明「开关不会删除/隐藏任何已有留言」。
    prisma.itemNote.count({
      where: { item: { familyId }, author: { memberships: { some: { familyId, role: 'viewer' } } } },
    }),
    prisma.item.count({ where: { familyId, deletedAt: null, status: 'published' } }),
  ]);

  const existingItemsByVisibility = {
    private: 0,
    family: 0,
    selected: 0,
    link: 0,
  } as Record<VisibilityValue, number>;
  for (const group of visibilityGroups) {
    existingItemsByVisibility[group.visibility as VisibilityValue] = group._count;
  }

  return {
    settingsVersion: family.settingsVersion,
    changes,
    impact: {
      existingItemsByVisibility,
      existingItemsKeepUnchanged: true,
      viewerCount,
      existingViewerNotes: viewerNotes,
      publishedItems,
      existingNotesKeepUnchanged: true,
    },
  };
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

