import { Alert, Button, Empty, Spin, Typography, message } from 'antd';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AppCard, OwnedAppCard } from '@aap/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { PortalAppCard } from '../components/PortalAppCard';
import { useSession } from '../state/session';
import { formatEntitlementCount } from '../lib/membershipPricing';

export function MyApplicationsPage() {
  const { me } = useSession();
  const qc = useQueryClient();
  const [cloningId, setCloningId] = useState<string | null>(null);
  const mine = useQuery({
    queryKey: ['my-apps'],
    queryFn: () => api<{ apps: OwnedAppCard[] }>('/api/apps/mine'),
    enabled: Boolean(me),
  });
  const shared = useQuery({
    queryKey: ['shared-apps'],
    queryFn: () => api<{ apps: AppCard[] }>('/api/apps/shared'),
    enabled: Boolean(me),
  });
  const siteShared = useQuery({
    queryKey: ['site-shared-apps'],
    queryFn: () => api<{ apps: AppCard[] }>('/api/apps/site-shared'),
    enabled: Boolean(me),
  });
  const membership = useQuery({
    queryKey: ['user-membership'],
    queryFn: () => api<{
      membership: { appCloneLimit: number; appsCloned: number; remainingCloneApps: number } | null;
    }>('/api/user/membership'),
    enabled: Boolean(me),
  });
  const groupedApps = useMemo(() => {
    const groups = new Map<string, AppCard[]>();
    for (const app of mine.data?.apps ?? []) {
      const apps = groups.get(app.category) ?? [];
      apps.push(app);
      groups.set(app.category, apps);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [mine.data]);
  const groupedSharedApps = useMemo(() => {
    const groups = new Map<string, AppCard[]>();
    for (const app of shared.data?.apps ?? []) {
      const apps = groups.get(app.category) ?? [];
      apps.push(app);
      groups.set(app.category, apps);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shared.data]);
  const groupedSiteApps = useMemo(() => {
    const groups = new Map<string, AppCard[]>();
    for (const app of siteShared.data?.apps ?? []) {
      const apps = groups.get(app.category) ?? [];
      apps.push(app);
      groups.set(app.category, apps);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [siteShared.data]);

  async function cloneSiteApp(app: AppCard): Promise<void> {
    setCloningId(app.id);
    try {
      await api(`/api/apps/${encodeURIComponent(app.id)}/clone`, { method: 'POST', json: {} });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['my-apps'] }),
        qc.invalidateQueries({ queryKey: ['site-shared-apps'] }),
        qc.invalidateQueries({ queryKey: ['user-membership'] }),
      ]);
      message.success(`已将「${app.name}」克隆到我自己的应用`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '克隆失败');
    } finally {
      setCloningId(null);
    }
  }

  if (!me) {
    return (
      <div className="aap-my-apps-page">
        <Alert type="info" showIcon message="请先登录" description={<Link to="/login">登录后查看你的应用</Link>} />
      </div>
    );
  }

  return (
    <div className="aap-account-page aap-my-apps-page aap-my-apps-dashboard">
      <header className="aap-account-heading">
        <Typography.Text className="aap-account-eyebrow">应用</Typography.Text>
        <Typography.Title level={2}>我的应用</Typography.Title>
      </header>
      <div className="aap-my-apps-content">
        {mine.isLoading || shared.isLoading || siteShared.isLoading || membership.isLoading ? (
          <div className="aap-home-loading"><Spin /></div>
        ) : (
          <>
            <section className="aap-home-category">
              <h3>我自己的</h3>
              <Typography.Paragraph>你创建或上传的应用；可在应用管理中维护配置、可见范围和发布状态。</Typography.Paragraph>
              {mine.isError ? (
                <Alert
                  type="error"
                  showIcon
                  message="我自己的应用加载失败"
                  description={mine.error instanceof Error ? mine.error.message : '请刷新页面重试'}
                />
              ) : groupedApps.length === 0 ? (
                <Empty description="还没有创建或上传应用。前往应用管理上传 .awpk 包，开始发布你的创作。" />
              ) : groupedApps.map(([category, apps]) => (
                <section key={category} className="aap-home-category">
                  {category !== '用户提交' ? <h4>{category}</h4> : null}
                  <div className="aap-home-app-grid">
                    {apps.map((app) => <PortalAppCard key={app.id} app={app} showVisibilityBadge />)}
                  </div>
                </section>
              ))}
            </section>
            <section className="aap-home-category">
              <h3>已共享的</h3>
              <Typography.Paragraph>其他用户或平台向你开放访问的应用，可直接使用。</Typography.Paragraph>
              {shared.isError ? (
                <Alert
                  type="error"
                  showIcon
                  message="已共享应用加载失败"
                  description={shared.error instanceof Error ? shared.error.message : '请刷新页面重试'}
                />
              ) : groupedSharedApps.length === 0 ? (
                <Empty description="目前没有向你开放的共享应用。" />
              ) : groupedSharedApps.map(([category, apps]) => (
                <section key={category} className="aap-home-category">
                  {category !== '用户提交' ? <h4>{category}</h4> : null}
                  <div className="aap-home-app-grid">
                    {apps.map((app) => <PortalAppCard key={app.id} app={app} showVisibilityBadge />)}
                  </div>
                </section>
              ))}
            </section>
            <section className="aap-home-category">
              <h3>站内共享</h3>
              <Typography.Paragraph>
                这些应用不能直接打开；克隆后会以“仅自己”范围加入“我自己的”，并占用当前权益的一个可克隆名额。
                当前剩余可克隆名额：{formatEntitlementCount(membership.data?.membership?.remainingCloneApps ?? 0, ' 个')}
              </Typography.Paragraph>
              {membership.isError ? (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="克隆名额加载失败"
                  description={membership.error instanceof Error ? membership.error.message : '请刷新页面重试'}
                />
              ) : null}
              {siteShared.isError ? (
                <Alert
                  type="error"
                  showIcon
                  message="站内共享应用加载失败"
                  description={siteShared.error instanceof Error ? siteShared.error.message : '请刷新页面重试'}
                />
              ) : groupedSiteApps.length === 0 ? (
                <Empty description="目前没有可克隆的站内共享应用。" />
              ) : groupedSiteApps.map(([category, apps]) => (
                <section key={category} className="aap-home-category">
                  {category !== '用户提交' ? <h4>{category}</h4> : null}
                  <div className="aap-home-app-grid">
                    {apps.map((app) => (
                      <PortalAppCard
                        key={app.id}
                        app={app}
                        hideQr
                        showVisibilityBadge
                        footerAction={(
                          <Button
                            size="small"
                            type="primary"
                            loading={cloningId === app.id}
                            disabled={cloningId !== null || (membership.data?.membership?.remainingCloneApps ?? 0) <= 0}
                            title={(membership.data?.membership?.remainingCloneApps ?? 0) <= 0 ? '当前权益没有可克隆名额' : '克隆到我自己的应用'}
                            onClick={() => void cloneSiteApp(app)}
                          >
                            克隆
                          </Button>
                        )}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
