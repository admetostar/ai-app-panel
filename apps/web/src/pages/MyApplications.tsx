import { Alert, Empty, Spin, Typography } from 'antd';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { AppCard, OwnedAppCard } from '@aap/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { PortalAppCard } from '../components/PortalAppCard';
import { useSession } from '../state/session';

export function MyApplicationsPage() {
  const { me } = useSession();
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
        <Typography.Paragraph>查看并打开你创建和上传的应用。发布状态、环境变量和应用删除请在应用管理中维护。</Typography.Paragraph>
      </header>
      <div className="aap-my-apps-content">
        {mine.isLoading || shared.isLoading ? (
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
                    {apps.map((app) => <PortalAppCard key={app.id} app={app} unavailableHref={null} />)}
                  </div>
                </section>
              ))}
            </section>
            <section className="aap-home-category">
              <h3>已共享的</h3>
              <Typography.Paragraph>其他用户或平台向你开放访问的应用，可按应用的可见范围使用。</Typography.Paragraph>
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
                    {apps.map((app) => <PortalAppCard key={app.id} app={app} unavailableHref={null} />)}
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
