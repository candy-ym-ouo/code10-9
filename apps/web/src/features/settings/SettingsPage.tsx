import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Field, SegmentedControl, Spinner, Tag, TextArea, TextInput } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { useFamily } from '../families/useFamily';
import { VISIBILITY_LABELS } from '../../lib/constants';
import { formatBytes, formatDateTime } from '../../lib/format';
import type { SettingsConflictDetails, SettingsPreview, ShareLink, Visibility } from '../../api/types';

interface ExportJob {
  jobId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  lastError: string | null;
  downloadUrl: string | null;
  result: { items?: number; media?: number; bytes?: number } | null;
}

const SETTING_FIELD_LABELS: Record<string, string> = {
  defaultVisibility: '新建条目的默认可见范围',
  allowViewerComment: '允许只读成员留言',
  name: '家庭名称',
  description: '说明',
};

function settingValueLabel(field: string, value: unknown): string {
  if (field === 'defaultVisibility') return VISIBILITY_LABELS[value as Visibility] ?? String(value);
  if (field === 'allowViewerComment') return value ? '开启' : '关闭';
  return value === null ? '（空）' : String(value);
}

export function SettingsPage() {
  const { fid } = useParams<{ fid: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { reloadMemberships } = useAuth();
  const { data: familyData } = useFamily(fid);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('family');
  const [allowViewerComment, setAllowViewerComment] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<SettingsConflictDetails | null>(null);

  // 编辑基线：打开页面（或一次成功保存）那一刻的快照与版本号。
  // 多管理员并发保存时，服务端靠它做三方合并。
  const [baseSnapshot, setBaseSnapshot] = useState<{
    name: string;
    description: string | null;
    defaultVisibility: Visibility;
    allowViewerComment: boolean;
  } | null>(null);
  const [expectedVersion, setExpectedVersion] = useState(1);

  useEffect(() => {
    if (!familyData) return;
    setName(familyData.family.name);
    setDescription(familyData.family.description ?? '');
    setVisibility(familyData.family.defaultVisibility);
    setAllowViewerComment(familyData.family.allowViewerComment);
    setExpectedVersion(familyData.family.settingsVersion);
    setBaseSnapshot({
      name: familyData.family.name,
      description: familyData.family.description,
      defaultVisibility: familyData.family.defaultVisibility,
      allowViewerComment: familyData.family.allowViewerComment,
    });
    setConflict(null);
  }, [familyData]);

  // 变更预览：只针对「默认可见范围 / 留言开关」两个字段，服务端纯计算不落库。
  const previewBody = useMemo(() => {
    if (!baseSnapshot) return null;
    return {
      defaultVisibility: visibility,
      allowViewerComment,
    };
  }, [baseSnapshot, visibility, allowViewerComment]);

  const preview = useQuery({
    queryKey: ['family-settings-preview', fid, previewBody],
    queryFn: () =>
      api.post<{ preview: SettingsPreview }>(`/families/${fid}/settings/preview`, previewBody ?? {}).then((r) => r.preview),
    enabled: Boolean(fid && previewBody),
    // 预览带的是草稿，关掉缓存复用，避免输入抖动时看到旧结果
    gcTime: 0,
    staleTime: 0,
  });

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
      api.patch<{ family: import('../../api/types').FamilyDetail }>(`/families/${fid}`, {
        name: name.trim(),
        description: description.trim() || null,
        defaultVisibility: visibility,
        allowViewerComment,
        expectedVersion,
        base: baseSnapshot,
      }),
    onSuccess: async (data) => {
      push('设置已保存', 'success');
      setExpectedVersion(data.family.settingsVersion);
      setBaseSnapshot({
        name: data.family.name,
        description: data.family.description,
        defaultVisibility: data.family.defaultVisibility,
        allowViewerComment: data.family.allowViewerComment,
      });
      setConflict(null);
      await queryClient.invalidateQueries({ queryKey: ['family', fid] });
      await reloadMemberships();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && err.details) {
        setConflict(err.details as SettingsConflictDetails);
        push('设置已被其他管理员修改，请按提示核对后再保存', 'error');
      } else {
        push(err instanceof ApiError ? err.message : '保存失败', 'error');
      }
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

  if (!familyData || !baseSnapshot) return <Spinner />;
  const isOwner = familyData.myRole === 'owner';
  const job = exportJob.data?.job;
  const previewData = preview.data;

  // 预览变更行：field/before/after 完全由服务端计算，前端不自己算差异
  const changeRows = previewData?.changes ?? [];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>家庭设置</h1>
          <p className="page-head__sub">数据只存在你自己的服务器上，可以随时导出成离线文件。</p>
        </div>
      </div>

      {conflict ? (
        <section className="card" style={{ borderColor: 'var(--danger, #b42318)' }}>
          <h2 style={{ marginBottom: 'var(--space-3)' }}>其他管理员刚刚保存过设置（版本 {conflict.currentVersion}）</h2>
          <p className="muted">
            为避免互相覆盖，这次保存已暂停。不冲突的改动会自动合并；下列字段两边都改了，请以右侧「当前值」为准重新选择后再保存。
          </p>
          <div className="log-list">
            {conflict.conflicts.map((c) => (
              <div key={c.field} className="log-item">
                <div className="log-item__body">
                  <div>{SETTING_FIELD_LABELS[c.field] ?? c.field}</div>
                  <div className="log-item__meta">
                    你的选择：{settingValueLabel(c.field, c.after)} · 当前值：
                    {settingValueLabel(c.field, conflict.current[c.field as keyof typeof conflict.current])}
                  </div>
                </div>
                <Tag tone="warn">冲突</Tag>
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 'var(--space-3)' }}>
            <Button
              variant="primary"
              onClick={() => {
                // 以服务端当前值为新基线：把被冲突的字段同步成当前值，未冲突字段保留自己的草稿
                setName(conflict.current.name);
                setDescription(conflict.current.description ?? '');
                setVisibility(conflict.current.defaultVisibility);
                setAllowViewerComment(conflict.current.allowViewerComment);
                setExpectedVersion(conflict.current.settingsVersion);
                setBaseSnapshot({
                  name: conflict.current.name,
                  description: conflict.current.description,
                  defaultVisibility: conflict.current.defaultVisibility,
                  allowViewerComment: conflict.current.allowViewerComment,
                });
                setConflict(null);
                push('已载入最新设置，可以在其基础上继续修改', 'success');
              }}
            >
              用最新设置覆盖我的草稿
            </Button>
            <Button onClick={() => setConflict(null)}>保留我的草稿，手动调整</Button>
          </div>
        </section>
      ) : null}

      <section className="card">
        <h2 style={{ marginBottom: 'var(--space-4)' }}>基本信息</h2>
        <Field label="家庭名称" required>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </Field>
        <Field label="说明">
          <TextArea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
        <Field
          label="新建条目的默认可见范围"
          group
          hint="只影响之后新建、且创建时没有单独选择可见范围的条目；已有条目的可见范围不会被改动。"
        >
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
        <label className="row" style={{ gap: 8, margin: 'var(--space-3) 0' }}>
          <input
            type="checkbox"
            checked={allowViewerComment}
            onChange={(e) => setAllowViewerComment(e.target.checked)}
          />
          <span>允许「只读」成员留言和补充故事（只影响之后的新留言，已有留言不受影响）</span>
        </label>

        {/* 变更预览：服务端按同一口径算出，保证预览与实际保存一致 */}
        <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 'var(--space-4)' }}>
          <div className="row row--between" style={{ marginBottom: 'var(--space-2)' }}>
            <strong>变更预览</strong>
            {preview.isFetching ? <Tag tone="muted">计算中…</Tag> : null}
          </div>
          {changeRows.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              默认可见范围与留言开关相对当前设置没有变化。历史条目的可见性与已有留言永远保持原口径，不会被这两个开关改动。
            </p>
          ) : (
            <div className="log-list">
              {changeRows.map((c) => (
                <div key={c.field} className="log-item">
                  <div className="log-item__body">
                    <div>{SETTING_FIELD_LABELS[c.field] ?? c.field}</div>
                    <div className="log-item__meta">
                      {settingValueLabel(c.field, c.before)} → {settingValueLabel(c.field, c.after)}
                    </div>
                  </div>
                  <Tag tone="warn">待保存</Tag>
                </div>
              ))}
            </div>
          )}
          {previewData ? (
            <div className="log-item__meta" style={{ marginTop: 'var(--space-2)' }}>
              影响面（仅统计现状，不改动历史）：现存条目
              {Object.entries(previewData.impact.existingItemsByVisibility)
                .filter(([, n]) => n > 0)
                .map(([v, n]) => `${VISIBILITY_LABELS[v as Visibility]} ${n}`)
                .join('、') || '暂无'}
              ；只读成员 {previewData.impact.viewerCount} 人，已有相关留言
              {previewData.impact.existingViewerNotes} 条——这些都保持不变。
            </div>
          ) : null}
        </div>

        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          保存设置
        </Button>
        <span className="field__hint" style={{ marginLeft: 8 }}>
          基于设置版本 v{expectedVersion}
          {familyData.family.settingsVersion !== expectedVersion ? '（页面加载后设置已更新）' : ''}
        </span>
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
