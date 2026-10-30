import { Alert, Button, Empty, Spin, Typography } from 'antd';
import { AppstoreOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { OwnedAppCard } from '@aap/shared';
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
  const groupedApps = useMemo(() => {
    const groups = new Map<string, OwnedAppCard[]>();
    for (const app of mine.data?.apps ?? []) {
      const apps = groups.get(app.category) ?? [];
      apps.push(app);
      groups.set(app.category, apps);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [mine.data]);

  if (!me) {
    return (
      <div className="aap-my-apps-page">
        <Alert type="info" showIcon message="请先登录" description={<Link to="/login">登录后查看你的应用</Link>} />
      </div>
    );
  }

  return (
    <div className="aap-home-page aap-my-apps-page">
      <section className="aap-home-section aap-home-applications">
        <div className="aap-home-section__inner">
          <span className="aap-home-section__eyebrow">MY APPLICATIONS</span>
          <Typography.Title level={2}>我的应用</Typography.Title>
          <Typography.Paragraph className="aap-home-section__lead">
            这里汇总你创建和上传的应用，点击卡片即可打开已启用的作品。管理发布状态、环境变量或删除应用，请前往应用管理。
          </Typography.Paragraph>
          <div className="aap-my-apps-actions">
            <Link to="/account?tab=myapps">
              <Button type="primary" icon={<AppstoreOutlined />}>前往应用管理</Button>
            </Link>
          </div>
          {mine.isLoading ? (
            <div className="aap-home-loading"><Spin /></div>
          ) : mine.isError ? (
            <Alert
              type="error"
              showIcon
              message="我的应用加载失败"
              description={mine.error instanceof Error ? mine.error.message : '请刷新页面重试'}
            />
          ) : groupedApps.length === 0 ? (
            <Empty description="还没有创建或上传应用。前往应用管理上传 .asp-app 包，开始发布你的创作。" />
          ) : (
            groupedApps.map(([category, apps]) => (
              <section key={category} className="aap-home-category">
                <h3>{category}</h3>
                <div className="aap-home-app-grid">
                  {apps.map((app) => (
                    <PortalAppCard key={app.id} app={app} unavailableHref={null} />
                  ))}
                </div>
              </section>
            ))
          )}
          <div className="aap-my-apps-footer-link">
            <Link to="/account?tab=myapps">管理我的应用 <ArrowRightOutlined /></Link>
          </div>
        </div>
      </section>
    </div>
  );
}
