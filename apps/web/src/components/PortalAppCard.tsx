import { LockOutlined } from '@ant-design/icons';
import { Card, Tag, Tooltip } from 'antd';
import type { AppCard } from '@aap/shared';
import { Link } from 'react-router-dom';
import { withBase } from '../lib/base';

const VISIBILITY_LABEL: Record<AppCard['visibility'], string> = {
  public: '公开',
  login: '需登录',
  restricted: '指定可见',
  private: '仅自己',
};

function StatusDot({ status }: { status: AppCard['status'] }) {
  const color = status === 'ok' ? '#52c41a' : status === 'down' ? '#ff4d4f' : '#98a2b3';
  const title = status === 'ok' ? '运行正常' : status === 'down' ? '上游异常' : '状态未知';
  return (
    <Tooltip title={title}>
      <span className="aap-app-status-dot" style={{ background: color }} />
    </Tooltip>
  );
}

export function PortalAppCard({
  app,
  unavailableHref = '/login',
}: {
  app: AppCard;
  unavailableHref?: string | null;
}) {
  const inner = (
    <Card
      size="small"
      hoverable={app.accessible}
      className="aap-app-card"
      style={{ height: '100%', opacity: app.accessible ? 1 : 0.72, borderColor: 'var(--aap-border)' }}
    >
      <div className="aap-app-card__main">
        <div className="aap-app-card__icon">{app.icon ?? app.name.slice(0, 1)}</div>
        <div className="aap-app-card__copy">
          <div className="aap-app-card__title">
            <span>{app.name}</span>
            <StatusDot status={app.status} />
            {!app.accessible ? <LockOutlined className="aap-app-card__lock" /> : null}
          </div>
          <div className="aap-app-card__description">{app.description || '　'}</div>
        </div>
      </div>
      <div className="aap-app-card__footer">
        <Tag bordered={false} style={{ fontSize: 11 }}>{VISIBILITY_LABEL[app.visibility]}</Tag>
        {app.accessible ? (
          <span className="aap-app-card__action">打开 →</span>
        ) : (
          <span className="aap-app-card__unavailable">
            {app.visibility === 'login' || app.visibility === 'restricted' ? '登录后可用' : '暂不可用'}
          </span>
        )}
      </div>
    </Card>
  );

  const isTool = app.kind === 'package' && app.runtimeMode === 'invoked';
  const target = withBase(isTool ? `/run/${app.id}` : `/app/${encodeURIComponent(app.id)}/`);
  if (app.accessible) {
    return <a className="aap-app-card-link" href={target}>{inner}</a>;
  }
  if (unavailableHref) {
    return <Link className="aap-app-card-link" to={unavailableHref}>{inner}</Link>;
  }
  return inner;
}
