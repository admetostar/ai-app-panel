import type { MembershipOrderSummary, MembershipPlanSummary } from '@aap/shared';

export function isFreeMembershipPlan(plan: MembershipPlanSummary): boolean {
  if (plan.priceCurrency === 'POINTS') return plan.pricePoints === 0;
  if (plan.priceCurrency === 'USD') return plan.priceCents === 0;
  return plan.priceFen === 0;
}

export function formatMembershipPlanPrice(plan: MembershipPlanSummary): string {
  if (isFreeMembershipPlan(plan)) return '免费';
  if (plan.priceCurrency === 'POINTS') return `${plan.pricePoints.toLocaleString()} 积分`;
  if (plan.priceCurrency === 'USD') return `$${(plan.priceCents / 100).toFixed(2)}`;
  return `¥${(plan.priceFen / 100).toFixed(2)}`;
}

export function formatEntitlementCount(value: number, unit = ''): string {
  return value > 0 ? `${value.toLocaleString()}${unit}` : '—';
}

export function formatMembershipOrderPrice(order: MembershipOrderSummary): string {
  return order.priceCurrency === 'USD'
    ? `$${(order.priceCents / 100).toFixed(2)}`
    : `¥${(order.priceFen / 100).toFixed(2)}`;
}
