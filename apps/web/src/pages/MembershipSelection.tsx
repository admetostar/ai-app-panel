import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Row, Spin, Typography, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { MembershipPlanSummary, UserMembershipData } from '@aap/shared';
import { api } from '../api/client';
import { TierBadge } from '../components/TierBadge';
import { formatEntitlementCount } from '../lib/membershipPricing';
import { useSession } from '../state/session';
import { formatMembershipPlanPrice, isFreeMembershipPlan } from '../lib/membershipPricing';

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
  const membership = useQuery({
    queryKey: ['membership'],
    queryFn: () => api<UserMembershipData>('/api/user/membership'),
    enabled: Boolean(me?.user.membershipSelectionRequired),
  });
  const [selectingPlan, setSelectingPlan] = useState<number | null>(null);
  const [skippingSelection, setSkippingSelection] = useState(false);

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

  async function skipSelection(): Promise<void> {
    setSkippingSelection(true);
    try {
      await api('/api/user/membership/skip-selection', { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate('/account', { replace: true });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '暂时无法跳过权益选择');
      await plans.refetch();
    } finally {
      setSkippingSelection(false);
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
    <div className="aap-home-page aap-membership-selection-page">
      <section className="aap-home-section aap-home-rights">
        <div className="aap-home-section__inner">
          <span className="aap-home-section__eyebrow">MEMBERSHIP</span>
          <Typography.Title level={2}>选择你的权益包</Typography.Title>
          <Typography.Paragraph className="aap-home-section__lead">
            选择适合你的权益，开启应用创作。零价权益包立即生效；人民币和美元套餐由管理员确认到账后开通；积分套餐足额扣分后立即开通。
          </Typography.Paragraph>
          <div className="aap-membership-selection-page__balance">
            <span>当前积分</span>
            {membership.isLoading ? (
              <Spin size="small" />
            ) : membership.isError ? (
              <Typography.Text type="danger">加载失败</Typography.Text>
            ) : (
              <strong>{(membership.data?.pointsBalance ?? 0).toLocaleString()} 分</strong>
            )}
          </div>
          {membership.isError ? (
            <Alert
              type="error"
              showIcon
              message="积分余额加载失败"
              description={membership.error instanceof Error ? membership.error.message : '请重试后再兑换积分套餐'}
              action={<Button size="small" onClick={() => void membership.refetch()}>重试</Button>}
              style={{ marginBottom: 20 }}
            />
          ) : null}

          {plans.isError ? (
            <Alert type="error" showIcon message="权益包加载失败" description={plans.error instanceof Error ? plans.error.message : '请刷新页面重试'} />
          ) : plans.isLoading ? (
            <div className="aap-home-loading"><Spin /></div>
          ) : enabledPlans.length === 0 ? (
            <Empty description="暂无可选择的权益包">
              <Button type="primary" loading={skippingSelection} onClick={() => void skipSelection()}>
                继续前往个人中心
              </Button>
            </Empty>
          ) : (
            <div className="aap-home-plan-grid">
              {enabledPlans.map((plan) => {
                const pointsInsufficient =
                  plan.priceCurrency === 'POINTS' &&
                  (membership.data?.pointsBalance ?? 0) < plan.pricePoints;
                return (
                  <Card key={plan.id} className="aap-home-plan-card" bordered>
                    <span className="aap-home-plan-card__duration">
                      {plan.durationDays >= 100_000 ? '长期权益' : `${plan.durationDays} 天有效期`}
                    </span>
                    <div className="aap-home-plan-card__name">
                      <TierBadge tier={plan.tier} size={26} />
                      <Typography.Title level={3}>{plan.name}</Typography.Title>
                    </div>
                    <div className="aap-home-plan-card__price">
                      {formatMembershipPlanPrice(plan)}
                      <span> / 套</span>
                    </div>
                    <div className="aap-home-plan-card__features">
                      <div><span>权益等级</span><strong>{plan.tier}</strong></div>
                      <div><span>权益分组</span><strong>{plan.groupName}</strong></div>
                      <div><span>可创建应用</span><strong>{formatEntitlementCount(plan.appUploadLimit, ' 个')}</strong></div>
                      <div><span>可克隆应用</span><strong>{formatEntitlementCount(plan.appCloneLimit, ' 个')}</strong></div>
                      <div><span>赠送额度</span><strong>{formatEntitlementCount(plan.tokenGrant)}</strong></div>
                    </div>
                    <Button
                      type="primary"
                      block
                      loading={selectingPlan === plan.id}
                      disabled={selectingPlan !== null || pointsInsufficient || (plan.priceCurrency === 'POINTS' && membership.isError)}
                      onClick={() => void selectPlan(plan)}
                    >
                      {pointsInsufficient
                        ? '积分不足'
                        : isFreeMembershipPlan(plan)
                          ? '获取'
                          : plan.priceCurrency === 'POINTS'
                            ? '立即兑换'
                            : '选择并创建待确认订单'}
                    </Button>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
