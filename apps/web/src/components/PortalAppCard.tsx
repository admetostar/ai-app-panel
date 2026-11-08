import { LockOutlined } from '@ant-design/icons';
import { Card, Tag, Tooltip } from 'antd';
import type { ReactNode } from 'react';
import type { AppCard } from '@aap/shared';
import { withBase } from '../lib/base';
import { useQuery } from '@tanstack/react-query';
import type { PortalBootstrap } from '@aap/shared';
import { api } from '../api/client';
import { appUrl } from '../lib/appUrl';
import { appVisibilityBadgeSrc, appVisibilityLabel } from '../lib/appVisibility';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

const VISIBILITY_LABEL: Record<AppCard['visibility'], string> = {
  public: '公开',
  login: '站内',
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
  footerAction,
  hideQr = false,
  showVisibilityBadge = false,
  hideVisibilityLabel = false,
}: {
  app: AppCard;
  footerAction?: ReactNode;
  hideQr?: boolean;
  showVisibilityBadge?: boolean;
  hideVisibilityLabel?: boolean;
}) {
  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api<PortalBootstrap>('/api/portal/bootstrap'),
  });
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const inner = (
    <Card
      size="small"
      hoverable
      className={`aap-app-card${showVisibilityBadge ? ' aap-app-card--visibility-badge' : ''}`}
      style={{ height: '100%', opacity: app.accessible ? 1 : 0.72, borderColor: 'var(--aap-border)' }}
    >
      {showVisibilityBadge ? (
        <img
          className="aap-app-card__visibility-badge"
          src={appVisibilityBadgeSrc(app.visibility, 'tag')}
          alt=""
          title={appVisibilityLabel(app.visibility)}
        />
      ) : null}
      <div className="aap-app-card__layout">
        <div className="aap-app-card__content">
          <div className="aap-app-card__main">
            <div className="aap-app-card__icon">
              {app.icon?.startsWith(`/api/apps/${encodeURIComponent(app.id)}/icon/`)
                ? <img src={withBase(app.icon)} alt="" />
                : app.icon ?? app.name.slice(0, 1)}
            </div>
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
            {!showVisibilityBadge && !hideVisibilityLabel ? (
              <Tag bordered={false} style={{ fontSize: 11 }}>{VISIBILITY_LABEL[app.visibility]}</Tag>
            ) : null}
            {!app.accessible ? (
              <span className="aap-app-card__unavailable">
                {app.visibility === 'login' ? '仅可克隆' : app.visibility === 'public' ? '暂不可用' : '需登录访问'}
              </span>
            ) : null}
            {footerAction}
          </div>
        </div>
        {!hideQr ? (
          <div className="aap-app-card__qr-drawer" aria-label={`${app.name}访问二维码`}>
            <div className="aap-app-card__qr-frame">
              {qr ? <img src={qr} alt={`${app.name}访问二维码`} /> : <span>{qrError ? '二维码不可用' : '生成中'}</span>}
            </div>
            <span>扫码访问</span>
          </div>
        ) : null}
      </div>
    </Card>
  );

  const isTool = app.kind === 'package' && app.runtimeMode === 'invoked';
  const target = isTool
    ? withBase(`/run/${app.id}`)
    : bootstrap.data
      ? appUrl(app.id, bootstrap.data.appDomainRoot, bootstrap.data.appPort)
      : withBase(`/app/${encodeURIComponent(app.id)}/`);
  useEffect(() => {
    let active = true;
    setQr(null);
    setQrError(false);
    if (hideQr) return;
    void QRCode.toDataURL(new URL(target, window.location.origin).toString(), {
      margin: 1,
      width: 160,
      color: { dark: '#111820', light: '#ffffff' },
    }).then((dataUrl) => {
      if (active) setQr(dataUrl);
    }).catch((error: unknown) => {
      if (active) {
        setQrError(true);
        console.error(`应用二维码生成失败（${app.id}）`, error);
      }
    });
    return () => {
      active = false;
    };
  }, [app.id, hideQr, target]);

  return app.accessible ? <a className="aap-app-card-link" href={target}>{inner}</a> : inner;
}
