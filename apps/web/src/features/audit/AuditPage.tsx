import { useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Avatar, EmptyState, Select, Spinner, Tag } from '../../components/ui';
import { ACTION_LABELS, VISIBILITY_LABELS } from '../../lib/constants';
import { formatDateTime } from '../../lib/format';
import type { AuditLog, FamilySettingKey, Visibility } from '../../api/types';

const SETTING_LABELS: Record<FamilySettingKey, string> = {
  name: '家庭名称',
  description: '说明',
  defaultVisibility: '默认可见范围',
  allowViewerComment: '只读成员留言',
};

function settingText(key: string, value: unknown): string {
  if (value === null || value === '') return '（空）';
  if (key === 'defaultVisibility') return VISIBILITY_LABELS[value as Visibility] ?? String(value);
  if (key === 'allowViewerComment') return value ? '允许留言' : '不允许留言';
  return String(value);
}

/**
 * 渲染家庭设置变更。兼容两代审计口径：
 * - 新：{ fields, before: {key: v}, after: {key: v} }（只含本次真正落库的字段）
 * - 旧：{ before: {name,...}, after: {name,...} }（固定三字段快照）
 */
function FamilyUpdateDiff({ diff }: { diff: unknown }): ReactNode {
  if (!diff || typeof diff !== 'object') return null;
  const d = diff as {
    fields?: unknown;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  };
  const beforeObj = d.before;
  const afterObj = d.after;
  if (!beforeObj || !afterObj) return null;

  const keys = Array.isArray(d.fields)
    ? (d.fields as string[])
    : Object.keys(afterObj).filter((k) => beforeObj[k] !== afterObj[k]);

  if (keys.length === 0) return <div className="log-item__meta">未产生实际变更</div>;

  return (
    <div className="log-item__meta" style={{ marginTop: 4 }}>
      {keys.map((key) => (
        <span key={key} style={{ marginRight: 12, whiteSpace: 'normal' }}>
          {SETTING_LABELS[key as FamilySettingKey] ?? key}：
          <span style={{ textDecoration: 'line-through', opacity: 0.7 }}>
            {settingText(key, beforeObj[key])}
          </span>
          {' → '}
          {settingText(key, afterObj[key])}
        </span>
      ))}
    </div>
  );
}

export function AuditPage() {
  const { fid } = useParams<{ fid: string }>();
  const [action, setAction] = useState('');

  const query = useQuery({
    queryKey: ['audit', fid, action],
    queryFn: () =>
      api.get<{ logs: AuditLog[] }>(`/families/${fid}/audit-logs?limit=120${action ? `&action=${action}` : ''}`),
    enabled: Boolean(fid),
  });

  const logs = query.data?.logs ?? [];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>家庭动态</h1>
          <p className="page-head__sub">谁在什么时候新建、修改、删除了什么，都会留下记录。</p>
        </div>
        <div className="field" style={{ marginBottom: 0, minWidth: 200 }}>
          <label className="field__label" htmlFor="audit-action">
            只看某类操作
          </label>
          <Select id="audit-action" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">全部操作</option>
            {Object.entries(ACTION_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {query.isLoading ? (
        <Spinner />
      ) : logs.length === 0 ? (
        <EmptyState icon="📝" title="还没有动态" description="家人开始建立条目后，这里会记录每一步操作。" />
      ) : (
        <section className="card">
          <div className="log-list">
            {logs.map((log) => (
              <div key={log.id} className="log-item">
                <Avatar name={log.actor.displayName} color={log.actor.avatarColor} size={34} />
                <div className="log-item__body">
                  <div className="row" style={{ gap: 'var(--space-2)' }}>
                    <strong>{log.actor.displayName}</strong>
                    <Tag>{ACTION_LABELS[log.action] ?? log.action}</Tag>
                    {log.targetType ? <span className="muted" style={{ fontSize: 12 }}>{log.targetType}</span> : null}
                  </div>
                  <div className="log-item__meta">
                    {formatDateTime(log.createdAt)}
                    {log.ip ? ` · ${log.ip}` : ''}
                  </div>
                  {log.action === 'family.update' ? <FamilyUpdateDiff diff={log.diff} /> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

