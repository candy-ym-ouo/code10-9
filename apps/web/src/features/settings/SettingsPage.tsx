import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Field, SegmentedControl, Select, Spinner, Tag, TextArea, TextInput } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { useFamily } from '../families/useFamily';
import { VISIBILITY_LABELS } from '../../lib/constants';
import { formatBytes, formatDateTime } from '../../lib/format';
import type { FamilySettingsPreview, FamilySettingKey, FamilySettingValue, ShareLink, Visibility } from '../../api/types';

interface ExportJob {
  jobId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  lastError: string | null;
  downloadUrl: string | null;
  result: { items?: number; media?: number; bytes?: number } | null;
}

const SETTING_LABELS: Record<FamilySettingKey, string> = {
  name: '家庭名称',
  description: '说明',
  defaultVisibility: '新建条目的默认可见范围',
  allowViewerComment: '允许只读成员留言',
};

function formatSettingValue(key: FamilySettingKey, value: FamilySettingValue): string {
  if (key === 'defaultVisibility') return VISIBILITY_LABELS[value as Visibility] ?? String(value);
  if (key === 'allowViewerComment') return value ? '允许留言' : '不允许留言';
  if (value === null || value === '') return '（空）';
  return String(value);
}

interface SaveConflictDetails {
  settingsVersion: number;
  current: {
    name: string;
    description: string | null;
    defaultVisibility: Visibility;
    allowViewerComment: boolean;
  };
  conflicts: { key: FamilySettingKey; yours: FamilySettingValue; theirs: FamilySettingValue }[];
}

export function SettingsPage() {
  const { fid } = useParams<{ fid: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { reloadMemberships } = useAuth();
  const { data: familyData } = useFamily(fid);

  // 设置页多管理员可能同时开着：后台轮询版本号，别人一保存就能在变更预览里看到「可自动合并 / 冲突」
  useEffect(() => {
    if (!fid) return;
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ['family', fid] });
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [fid, queryClient]);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('family');
  const [allowViewerComment, setAllowViewerComment] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  // 本次编辑开始时的家庭设置（乐观锁 base）；保存冲突后由服务端返回值刷新
  const [base, setBase] = useState<{
    name: string;
    description: string | null;
    defaultVisibility: Visibility;
    allowViewerComment: boolean;
    settingsVersion: number;
  } | null>(null);
  const [conflict, setConflict] = useState<SaveConflictDetails | null>(null);
  const baseRef = useRef(base);
  baseRef.current = base;

  // 仅在版本推进时把表单同步到最新设置，避免后台 refetch 把正在编辑的内容冲掉
  useEffect(() => {
    const f = familyData?.family;
    if (!f) return;
    if (base && base.settingsVersion === f.settingsVersion) return;
    setName(f.name);
    setDescription(f.description ?? '');
    setVisibility(f.defaultVisibility);
    setAllowViewerComment(f.allowViewerComment);
    setBase({
      name: f.name,
      description: f.description,
      defaultVisibility: f.defaultVisibility,
      allowViewerComment: f.allowViewerComment,
      settingsVersion: f.settingsVersion,
    });
    setConflict(null);
    // 版本变了（另一位管理员刚保存），让变更预览立即按新版本重算
    queryClient.invalidateQueries({ queryKey: ['family-settings-preview', fid] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [familyData]);

  const patch = useMemo(() => {
    if (!base) return null;
    const p: Record<string, unknown> = {};
    const nextName = name.trim();
    if (nextName !== base.name) p.name = nextName;
    const nextDesc = description.trim() || null;
    if (nextDesc !== base.description) p.description = nextDesc;
    if (visibility !== base.defaultVisibility) p.defaultVisibility = visibility;
    if (allowViewerComment !== base.allowViewerComment) p.allowViewerComment = allowViewerComment;
    return Object.keys(p).length > 0 ? p : null;
  }, [base, name, description, visibility, allowViewerComment]);

  // 输入停顿 400ms 后再请求预览，避免每敲一个字都打一次接口
  const [debouncedPatch, setDebouncedPatch] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedPatch(patch), 400);
    return () => window.clearTimeout(timer);
  }, [patch]);

  const preview = useQuery({
    queryKey: ['family-settings-preview', fid, base?.settingsVersion, debouncedPatch],
    queryFn: () =>
      api.post<{ preview: FamilySettingsPreview }>(`/families/${fid}/settings/preview`, {
        expectedVersion: base!.settingsVersion,
        base: {
          name: base!.name,
          description: base!.description,
          defaultVisibility: base!.defaultVisibility,
          allowViewerComment: base!.allowViewerComment,
        },
        patch: debouncedPatch,
      }),
    enabled: Boolean(fid && base && debouncedPatch),
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const previewData = preview.data?.preview ?? null;

  const shareLinks = useQuery({
    queryKey: ['share-links', fid],
    queryFn: () => api.get<{ shareLinks: ShareLink[] }>(`/families/${fid}/share-links`),
    enabled: Boolean(fid),
  });

  const exportJob = useQuery({
    queryKey: ['export', fid, jobId],
    queryFn: () => api.get<{ job: ExportJob }>(`/families/${fid}/exports/${jobId}`),
    enabled: Boolean(fid && jobId),
    refetchInterval: (q) => {
      const data = q.state.data as { job: ExportJob } | undefined;
      return data && (data.job.status === 'done' || data.job.status === 'failed') ? false : 1500;
    },
  });

  const save = useMutation({
    mutationFn: () =>
      api.patch<{
        family: typeof base & { id: string };
        meta: {
          changes: FamilySettingsPreview['changes'];
          stale: boolean;
          merged: boolean;
          noop: boolean;
        };
      }>(`/families/${fid}`, {
        name: name.trim(),
        description: description.trim() || null,
        defaultVisibility: visibility,
        allowViewerComment,
        expectedVersion: baseRef.current?.settingsVersion,
        base: baseRef.current
          ? {
              name: baseRef.current.name,
              description: baseRef.current.description,
              defaultVisibility: baseRef.current.defaultVisibility,
              allowViewerComment: baseRef.current.allowViewerComment,
            }
          : undefined,
      }),
    onSuccess: async (data) => {
      setConflict(null);
      if (data.meta.noop) {
        push('没有需要保存的改动', 'info');
      } else if (data.meta.merged) {
        push('已保存，并自动合并了另一位管理员刚刚的修改', 'success');
      } else {
        push('设置已保存', 'success');
      }
      await queryClient.invalidateQueries({ queryKey: ['family', fid] });
      await reloadMemberships();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        const details = err.details as SaveConflictDetails | undefined;
        if (details?.conflicts?.length) {
          setConflict(details);
          push('另一位管理员同时修改了同一设置，请核对后选择保留谁的修改', 'error');
          return;
        }
      }
      push(err instanceof ApiError ? err.message : '保存失败', 'error');
    },
  });

  const startExport = useMutation({
    mutationFn: () => api.post<{ jobId: string }>(`/families/${fid}/exports`),
    onSuccess: (data) => {
      setJobId(data.jobId);
      push('导出任务已开始，完成后可以直接下载', 'success');
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '发起导出失败', 'error'),
  });

  const revoke = useMutation({
    mutationFn: (linkId: string) => api.del(`/families/${fid}/share-links/${linkId}`),
    onSuccess: async () => {
      push('分享链接已撤销', 'success');
      await queryClient.invalidateQueries({ queryKey: ['share-links', fid] });
    },
  });

  const removeFamily = useMutation({
    mutationFn: () => api.del(`/families/${fid}`),
    onSuccess: async () => {
      push('家庭空间已删除', 'success');
      await reloadMemberships();
      navigate('/');
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '删除失败', 'error'),
  });

  if (!familyData) return <Spinner />;
  const isOwner = familyData.myRole === 'owner';
  const job = exportJob.data?.job;

  const applyServerState = (s: SaveConflictDetails['current'], version: number) => {
    setName(s.name);
    setDescription(s.description ?? '');
    setVisibility(s.defaultVisibility);
    setAllowViewerComment(s.allowViewerComment);
    setBase({
      name: s.name,
      description: s.description,
      defaultVisibility: s.defaultVisibility,
      allowViewerComment: s.allowViewerComment,
      settingsVersion: version,
    });
    setConflict(null);
  };

  // 冲突解决：放弃本地修改，采用另一位管理员已保存的版本
  const keepTheirs = () => {
    if (conflict) applyServerState(conflict.current, conflict.settingsVersion);
    push('已采用最新的家庭设置', 'info');
  };

  // 冲突解决：保留我屏幕上的值，并把 base 移到最新版本，随后可以再点保存
  const keepMine = () => {
    if (!conflict) return;
    setBase({
      name: conflict.current.name,
      description: conflict.current.description,
      defaultVisibility: conflict.current.defaultVisibility,
      allowViewerComment: conflict.current.allowViewerComment,
      settingsVersion: conflict.settingsVersion,
    });
    setConflict(null);
    push('已保留你的修改，请再点一次「保存设置」使其生效', 'info');
  };

  const hasConflict = !conflict && (previewData?.conflictLines.length ?? 0) > 0;
  const nameInvalid = name.trim() === '';

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>家庭设置</h1>
          <p className="page-head__sub">数据只存在你自己的服务器上，可以随时导出成离线文件。</p>
        </div>
      </div>

      <section className="card">
        <div className="card__head">
          <h2>基本信息</h2>
          {base ? <Tag tone="muted">当前版本 v{base.settingsVersion}</Tag> : null}
        </div>
        <Field label="家庭名称" required>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-invalid={nameInvalid} />
          {nameInvalid ? <p className="field__error">家庭名称不能为空</p> : null}
        </Field>
        <Field label="说明">
          <TextArea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
        <Field label="新建条目的默认可见范围" group>
          <SegmentedControl
            name="默认可见范围"
            value={visibility}
            onChange={setVisibility}
            options={(Object.keys(VISIBILITY_LABELS) as Visibility[]).map((v) => ({
              value: v,
              label: VISIBILITY_LABELS[v],
            }))}
          />
        </Field>
        <label className="row" style={{ gap: 8, marginBottom: 'var(--space-4)' }}>
          <input
            type="checkbox"
            checked={allowViewerComment}
            onChange={(e) => setAllowViewerComment(e.target.checked)}
          />
          <span>允许「只读」成员留言和补充故事</span>
        </label>

        {/* 保存前预览：会改什么、影响什么、和谁撞了车；与真正保存共用同一套合并口径 */}
        {patch && !conflict ? (
          <div
            className="card"
            style={{
              background: hasConflict ? 'var(--warn-soft)' : 'var(--surface-2)',
              marginBottom: 'var(--space-4)',
            }}
          >
            <div className="row row--between" style={{ marginBottom: 'var(--space-2)' }}>
              <strong>{hasConflict ? '检测到并发冲突' : '变更预览'}</strong>
              {preview.isFetching ? <span className="muted" style={{ fontSize: 12 }}>正在核对…</span> : null}
            </div>
            {previewData?.stale && !hasConflict ? (
              <p className="field__hint" style={{ color: 'var(--warn)' }}>
                另一位管理员刚保存过不相关的设置，本次保存会自动合并双方修改。
              </p>
            ) : null}
            {previewData?.changeLines.map((line) => (
              <div key={line.key} className="log-item" style={{ paddingLeft: 0 }}>
                <div className="log-item__body">
                  <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <strong>{line.label}</strong>
                    <span className="muted" style={{ textDecoration: 'line-through' }}>{line.before}</span>
                    <span aria-hidden>→</span>
                    <Tag tone="success">{line.after}</Tag>
                  </div>
                  <div className="log-item__meta">{line.hint}</div>
                </div>
              </div>
            ))}
            {previewData?.conflictLines.map((c) => (
              <div key={c.key} className="log-item" style={{ paddingLeft: 0 }}>
                <div className="log-item__body">
                  <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <strong>{c.label}</strong>
                    <Tag tone="warn">你的修改：{c.yours}</Tag>
                    <Tag tone="muted">管理员已保存：{c.theirs}</Tag>
                  </div>
                  <div className="log-item__meta">同一字段被改成了不同值，无法自动合并；请先选择保留谁的修改。</div>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {conflict ? (
          <div className="card" style={{ background: 'var(--warn-soft)', marginBottom: 'var(--space-4)' }}>
            <strong>保存时发生冲突（对方已是 v{conflict.settingsVersion}）</strong>
            {conflict.conflicts.map((c) => (
              <div key={c.key} className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 6 }}>
                <strong>{SETTING_LABELS[c.key]}：</strong>
                <Tag tone="warn">你的值：{formatSettingValue(c.key, c.yours)}</Tag>
                <Tag tone="muted">已保存：{formatSettingValue(c.key, c.theirs)}</Tag>
              </div>
            ))}
            <div className="row" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
              <Button size="sm" variant="primary" onClick={keepTheirs}>
                采用对方的修改
              </Button>
              <Button size="sm" onClick={keepMine}>
                保留我的，再保存一次
              </Button>
            </div>
          </div>
        ) : null}

        <Button
          variant="primary"
          loading={save.isPending}
          disabled={nameInvalid || hasConflict || !patch}
          onClick={() => save.mutate()}
        >
          保存设置
        </Button>
        {!patch && !conflict ? <span className="muted" style={{ marginLeft: 'var(--space-3)' }}>还没有改动</span> : null}
      </section>

      <section className="card">
        <div className="card__head">
          <h2>导出全部数据</h2>
          <Button variant="primary" loading={startExport.isPending} onClick={() => startExport.mutate()}>
            开始导出
          </Button>
        </div>
        <p className="muted">
          导出包含一个 ZIP：条目总表（items.csv）、每条物品的 Markdown 档案、全部原始图片与录音，以及带 sha256 校验的媒体清单。不依赖本系统也能打开。
        </p>
        {job ? (
          <div className="card" style={{ background: 'var(--surface-2)' }}>
            <div className="row row--between">
              <span>
                状态：
                {job.status === 'queued'
                  ? '排队中'
                  : job.status === 'running'
                    ? `生成中 ${job.progress}%`
                    : job.status === 'done'
                      ? '已完成'
                      : '失败'}
              </span>
              {job.status === 'done' && job.downloadUrl ? (
                <a className="btn btn--primary btn--sm" href={job.downloadUrl}>
                  下载 ZIP
                  {job.result?.bytes ? `（${formatBytes(job.result.bytes)}）` : ''}
                </a>
              ) : null}
            </div>
            {job.lastError ? <p className="field__error">{job.lastError}</p> : null}
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2 style={{ marginBottom: 'var(--space-3)' }}>已创建的分享链接</h2>
        {(shareLinks.data?.shareLinks ?? []).length === 0 ? (
          <p className="muted">还没有分享过内容。打开某个条目，点「分享」即可生成链接。</p>
        ) : (
          <div className="log-list">
            {(shareLinks.data?.shareLinks ?? []).map((link) => {
              const expired = new Date(link.expiresAt).getTime() < Date.now();
              const active = !link.revokedAt && !expired;
              return (
                <div key={link.id} className="log-item">
                  <div className="log-item__body">
                    <div className="row" style={{ gap: 'var(--space-2)' }}>
                      <span>{link.label || '未命名分享'}</span>
                      {link.hasPassword ? <Tag>有密码</Tag> : null}
                      {active ? <Tag tone="success">有效</Tag> : <Tag tone="muted">{link.revokedAt ? '已撤销' : '已过期'}</Tag>}
                    </div>
                    <div className="log-item__meta">
                      访问 {link.accessCount} 次 · 有效期至 {formatDateTime(link.expiresAt)}
                      {link.lastAccessAt ? ` · 最近 ${formatDateTime(link.lastAccessAt)}` : ''}
                    </div>
                  </div>
                  {active ? (
                    <Button size="sm" onClick={() => revoke.mutate(link.id)}>
                      撤销
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card__head">
          <h2>回收站</h2>
          <Link className="btn btn--sm" to={`/f/${fid}/trash`}>
            打开回收站
          </Link>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          被删除的条目会保留 30 天，期间可以恢复；到期后连同图片、录音一起彻底清除。
        </p>
      </section>

      {isOwner ? (
        <section className="card" style={{ borderColor: 'var(--accent)' }}>
          <h2 style={{ marginBottom: 'var(--space-3)', color: 'var(--accent)' }}>危险操作</h2>
          <p className="muted">
            删除家庭空间后，所有条目、图片、录音都会不可访问（备份中的副本按备份保留策略自然过期）。请输入家庭名称
            <strong>{familyData.family.name}</strong> 以确认。
          </p>
          <Field label="输入家庭名称确认">
            <TextInput value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
          </Field>
          <Button
            variant="danger"
            loading={removeFamily.isPending}
            disabled={confirmName !== familyData.family.name}
            onClick={() => removeFamily.mutate()}
          >
            删除整个家庭空间
          </Button>
        </section>
      ) : null}
    </div>
  );
}
