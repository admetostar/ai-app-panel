/** 门户首页（A1）：应用卡片墙——分类分组、搜索、锁定态、健康状态点。 */
import { Alert, Button, Card, Collapse, Empty, Input, Space, Spin, Typography } from 'antd';
import { ArrowRightOutlined, SearchOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { AppCard, MembershipPlanSummary, PortalBootstrap } from '@aap/shared';
import { api } from '../api/client';
import { useSession } from '../state/session';
import { GUIDE_FAQ_ITEMS } from '../lib/guideFaq';
import { formatEntitlementCount, formatMembershipPlanPrice } from '../lib/membershipPricing';
import { PortalAppCard } from '../components/PortalAppCard';
import { TierBadge } from '../components/TierBadge';

function planDurationLabel(days: number): string {
  if (days === 30) return '月度权益';
  if (days === 90) return '季度权益';
  if (days === 365) return '年度权益';
  return days >= 100_000 ? '长期权益' : `${days} 天`;
}

export function HomePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { me } = useSession();
  const [keyword, setKeyword] = useState('');
  const appsQuery = useQuery({
    queryKey: ['apps'],
    queryFn: () => api<{ apps: AppCard[] }>('/api/apps'),
  });
  const data = appsQuery.data;
  const boot = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api<PortalBootstrap>('/api/portal/bootstrap'),
  });
  const plans = useQuery({
    queryKey: ['portal-plans'],
    queryFn: () => api<{ plans: MembershipPlanSummary[] }>('/api/portal/plans'),
  });
  const planRows = plans.data?.plans ?? [];
  const siteName = boot.data?.branding.siteName ?? 'ai-app-panel';

  useEffect(() => {
    if (!location.hash) return;
    requestAnimationFrame(() => {
      document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [location.hash]);

  const filtered = useMemo(() => {
    const apps = data?.apps ?? [];
    const kw = keyword.trim().toLowerCase();
    const hit = apps.filter(
      (a) => !kw || a.name.toLowerCase().includes(kw) || a.description.toLowerCase().includes(kw),
    );
    const groups = new Map<string, AppCard[]>();
    for (const a of hit) {
      const list = groups.get(a.category) ?? [];
      list.push(a);
      groups.set(a.category, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data, keyword]);

  return (
    <div className="aap-home-page">
      <section className="aap-home-hero">
        <div className="aap-home-hero__content">
          <span className="aap-home-kicker">{siteName}</span>
          <Typography.Title className="aap-home-title" level={1}>
            您好，欢迎来到 {siteName}
          </Typography.Title>
          <Typography.Paragraph className="aap-home-description">
            {boot.data?.needsInit
              ? '⚠ 站点尚未初始化：请首次启动时按容器日志中的初始凭据登录完成引导。'
              : <>
                  <strong>{siteName}</strong> 是一个应用托管仓库。您让自己的 AI 助手（Agent）写好一个小工具，自动打包成 <strong>.awpk</strong> 文件上传到{siteName}后，即可向其他人展示您的创作。
                </>}
          </Typography.Paragraph>
          <Input
            allowClear
            size="large"
            className="aap-home-search"
            prefix={<SearchOutlined />}
            placeholder="搜索应用名称或介绍"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={() => document.getElementById('home-applications')?.scrollIntoView({ behavior: 'smooth' })}
          />
          <Button
            className="aap-home-hero__cta"
            size="large"
            type="primary"
            icon={<ArrowRightOutlined />}
            onClick={() => navigate(me ? '/my-apps' : '/guide')}
          >
            现在开始
          </Button>
        </div>
        <a className="aap-home-scroll" href="#home-applications">向下探索 <span aria-hidden="true">↓</span></a>
      </section>

      <section id="home-applications" className="aap-home-section aap-home-applications">
        <div className="aap-home-section__inner">
          <span className="aap-home-section__eyebrow">APPLICATIONS</span>
          <Typography.Title level={2}>发现应用</Typography.Title>
          <Typography.Paragraph className="aap-home-section__lead">浏览社区创作，找到适合你的 AI 应用。</Typography.Paragraph>
          {appsQuery.isLoading ? (
            <div className="aap-home-loading"><Spin /></div>
          ) : appsQuery.isError ? (
            <Alert type="error" showIcon message="应用列表加载失败" description={appsQuery.error instanceof Error ? appsQuery.error.message : '请刷新页面重试'} />
          ) : filtered.length === 0 ? (
            <Empty
              description={
                keyword
                  ? '没有匹配的应用'
                  : '还没有公开发布的应用，欢迎注册本站后按操作指南发布您的应用创作。'
              }
            />
          ) : (
            filtered.map(([category, apps]) => (
              <section key={category} className="aap-home-category">
                <h3>{category}</h3>
                <div className="aap-home-app-grid">
                  {apps.map((app) => <PortalAppCard key={app.id} app={app} />)}
                </div>
              </section>
            ))
          )}
        </div>
      </section>

      <section id="home-rights" className="aap-home-section aap-home-rights">
        <div className="aap-home-section__inner">
          <span className="aap-home-section__eyebrow">MEMBERSHIP</span>
          <Typography.Title level={2}>选择适合你的权益</Typography.Title>
          <Typography.Paragraph className="aap-home-section__lead">先从基础权益开始，按需解锁更多应用上传空间。</Typography.Paragraph>
          {plans.isLoading ? (
            <div className="aap-home-loading"><Spin /></div>
          ) : plans.isError ? (
            <Alert type="error" showIcon message="权益套餐加载失败" description={plans.error instanceof Error ? plans.error.message : '请刷新页面重试'} />
          ) : planRows.length === 0 ? (
            <Empty description="暂无可选择的权益包" />
          ) : (
            <div className="aap-home-plan-grid">
              {planRows.map((plan) => (
                <Card key={plan.id} className="aap-home-plan-card" bordered>
                  <span className="aap-home-plan-card__duration">{planDurationLabel(plan.durationDays)}</span>
                  <Space align="center" size={8}>
                    <TierBadge tier={plan.tier} size={26} />
                    <Typography.Title level={3}>{plan.name}</Typography.Title>
                  </Space>
                  <div className="aap-home-plan-card__price">{formatMembershipPlanPrice(plan)}<span> / 套</span></div>
                  <div className="aap-home-plan-card__features">
                    <div><span>权益分组</span><strong>{plan.groupName}</strong></div>
                    <div><span>可创建应用</span><strong>{formatEntitlementCount(plan.appUploadLimit, ' 个')}</strong></div>
                    <div><span>可克隆应用</span><strong>{formatEntitlementCount(plan.appCloneLimit, ' 个')}</strong></div>
                    <div><span>赠送额度</span><strong>{formatEntitlementCount(plan.tokenGrant)}</strong></div>
                    <div><span>有效时间</span><strong>{plan.durationDays >= 100_000 ? '长期' : `${plan.durationDays} 天`}</strong></div>
                  </div>
                  <Button
                    block
                    type="primary"
                    onClick={() => navigate(me ? '/account?tab=billing' : '/login')}
                  >
                    {me ? '前往获取' : '登录后获取'}
                  </Button>
                </Card>
              ))}
            </div>
          )}
        </div>
      </section>

      <section id="home-faq" className="aap-home-section aap-home-faq">
        <div className="aap-home-section__inner">
          <span className="aap-home-section__eyebrow">FAQ</span>
          <Typography.Title level={2}>常见问题</Typography.Title>
          <div className="aap-home-faq__content">
            <Collapse
              ghost
              items={GUIDE_FAQ_ITEMS.map((item, index) => ({
                key: String(index),
                label: item.question,
                children: <Typography.Paragraph>{item.answer}</Typography.Paragraph>,
              }))}
            />
            <div className="aap-home-faq__guide">
              <Typography.Text type="secondary">想了解完整的应用制作与发布流程？</Typography.Text>
              <Link to="/guide">查看操作指南 <ArrowRightOutlined /></Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
