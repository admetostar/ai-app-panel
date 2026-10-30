import { Tooltip } from 'antd';
import { tierIconSrc } from '../lib/tierIcons';

export function TierBadge({
  tier,
  size = 22,
  showTierLabel = true,
}: {
  tier: number;
  size?: number;
  showTierLabel?: boolean;
}) {
  const src = tierIconSrc(tier);
  if (!src) {
    return showTierLabel ? <span className="aap-tier-badge aap-tier-badge--base">等级 {tier}</span> : null;
  }

  return (
    <Tooltip title={`权益等级 ${tier}`}>
      <span className={`aap-tier-badge${showTierLabel ? '' : ' aap-tier-badge--icon-only'}`}>
        <img src={src} width={size} height={size} alt={`权益等级 ${tier}`} />
        {showTierLabel ? <span>等级 {tier}</span> : null}
      </span>
    </Tooltip>
  );
}
