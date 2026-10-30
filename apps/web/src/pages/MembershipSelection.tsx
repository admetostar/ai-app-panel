import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Row, Space, Typography, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { MembershipPlanSummary } from '@aap/shared';
import { api } from '../api/client';
import { TierBadge } from '../components/TierBadge';
import { useSession } from '../state/session';

interface PlanSelectionResult {
  activated: boolean;
  planName: string;
  orderId: string | null;
}

export function MembershipSelectionPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { me, loading: sessionLoading } = useSession();
  const plans = useQuery({
    queryKey: ['portal-plans'],
    queryFn: () => api<{ plans: MembershipPlanSummary[] }>('/api/portal/plans'),
  });
  const [selectingPlan, setSelectingPlan] = useState<number | null>(null);

  useEffect(() => {
    if (me && !me.user.membershipSelectionRequired) navigate('/account', { replace: true });
  }, [me, navigate]);

  async function selectPlan(plan: MembershipPlanSummary): Promise<void> {
    setSelectingPlan(plan.id);
    try {
      const result = await api<PlanSelectionResult>('/api/user/membership/select-plan', {
        method: 'POST',
        json: { planId: plan.id },
      });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await queryClient.invalidateQueries({ queryKey: ['membership'] });
      if (result.activated) {
        message.success(`已获取「${result.planName}」，权益立即生效`);
        navigate('/account', { replace: true });
      } else {
        message.success(`已为「${result.planName}」创建待确认订单，请在个人中心查看`);
        navigate('/account?tab=billing', { replace: true });
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '选择权益包失败');
    } finally {
      setSelectingPlan(null);
    }
  }

  const enabledPlans = plans.data?.plans ?? [];

  if (sessionLoading) {
    return <div style={{ maxWidth: 1040, margin: '48px auto', padding: '0 20px' }}>正在确认登录状态…</div>;
  }
  if (!me) {
    return (
      <div style={{ maxWidth: 720, margin: '48px auto', padding: '0 20px' }}>
        <Alert
          type="info"
          showIcon
          message="请先登录"
          description={<a onClick={() => navigate('/login')}>登录后选择权益包</a>}
        />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1040, margin: '48px auto', padding: '0 20px' }}>
      <Typography.Text type="secondary" style={{ letterSpacing: 2 }}>MEMBERSHIP</Typography.Text>
      <Typography.Title level={2} style={{ marginTop: 8 }}>选择你的权益包</Typography.Title>
      <Typography.Paragraph style={{ maxWidth: 720, color: 'var(--aap-text-secondary)' }}>
        选择适合你的权益，开启应用创作。零价权益包选择后立即生效；付费权益包会创建待确认订单，管理员确认后开通。
      </Typography.Paragraph>

      {plans.isError ? (
        <Alert type="error" showIcon message="权益包暂时无法加载" description="请刷新页面重试；如果问题持续，请联系管理员。" />
      ) : plans.isLoading ? (
        <Typography.Text type="secondary">正在加载可选权益包…</Typography.Text>
      ) : enabledPlans.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          message="当前没有可选择的权益包"
          description="请联系管理员配置并启用权益包后再继续。"
        />
      ) : (
        <Row gutter={[18, 18]} style={{ marginTop: 28 }}>
          {enabledPlans.map((plan) => (
            <Col key={plan.id} xs={24} sm={12} lg={8}>
              <Card
                style={{ height: '100%', borderColor: '#e5e7eb', background: '#fff' }}
                styles={{ body: { display: 'flex', flexDirection: 'column', minHeight: 250 } }}
              >
                <Space align="center" size={10}>
                  <TierBadge tier={plan.tier} size={30} showTierLabel={false} />
                  <Typography.Title level={4} style={{ margin: 0 }}>{plan.name}</Typography.Title>
                </Space>
                <Typography.Title level={2} style={{ margin: '24px 0 8px' }}>
                  {plan.priceFen === 0 ? '免费' : `¥${(plan.priceFen / 100).toFixed(2)}`}
                </Typography.Title>
                <Typography.Text type="secondary">{plan.durationDays} 天有效期</Typography.Text>
                <div style={{ marginTop: 18, display: 'grid', gap: 8, color: 'var(--aap-text-secondary)' }}>
                  <span>权益等级：{plan.tier}</span>
                  <span>应用发布：{plan.publicAppLimit} 个</span>
                  {plan.tokenGrant > 0 ? <span>包含额度：{plan.tokenGrant.toLocaleString()}</span> : null}
                </div>
                <Button
                  type="primary"
                  block
                  style={{ marginTop: 'auto', paddingTop: 22 }}
                  loading={selectingPlan === plan.id}
                  disabled={selectingPlan !== null}
                  onClick={() => void selectPlan(plan)}
                >
                  {plan.priceFen === 0 ? '获取' : '选择并创建待确认订单'}
                </Button>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </div>
  );
}
