import { Alert, Button, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { safeReturnTo, withBase } from '../lib/base';
import { useSession } from '../state/session';

const COUNTDOWN_SECONDS = 5;

export function AppLoginReturnPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { me, loading: sessionLoading } = useSession();
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const requestedAppId = searchParams.get('appId');
  const appId = requestedAppId && (/^[a-z0-9][a-z0-9-]{0,63}$/.test(requestedAppId) || /^clone_[0-9a-f]{8}$/.test(requestedAppId))
    ? requestedAppId
    : null;
  const requestedTarget = safeReturnTo(searchParams.get('target'));
  const target = appId && requestedTarget?.startsWith(`/app/${appId}/`)
    ? requestedTarget
    : appId ? `/app/${appId}/` : null;
  const returnPage = appId && target
    ? `/app-login-return?${new URLSearchParams({ appId, target }).toString()}`
    : '/account';
  const accessCheck = useQuery({
    queryKey: ['app-login-redirect', appId],
    queryFn: () => api<{ openApp: boolean }>(`/api/apps/${encodeURIComponent(appId!)}/login-redirect`),
    enabled: Boolean(appId && me?.authState === 'full' && !me.user.membershipSelectionRequired),
    retry: false,
  });

  useEffect(() => {
    if (me?.authState === 'full' && me.user.membershipSelectionRequired) {
      navigate(`/membership-selection?returnTo=${encodeURIComponent(returnPage)}`, { replace: true });
      return;
    }
    if (!accessCheck.data || !target) return;
    if (accessCheck.data.openApp) {
      window.location.replace(withBase(target));
      return;
    }
    if (countdown <= 0) {
      navigate('/account', { replace: true });
      return;
    }
    const timer = window.setTimeout(() => setCountdown((current) => current - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [accessCheck.data, countdown, me?.authState, me?.user.membershipSelectionRequired, navigate, returnPage, target]);

  if (!appId || !target) {
    return (
      <Alert
        type="error"
        showIcon
        message="无法确认目标应用"
        description={<Link to="/account">进入个人中心</Link>}
      />
    );
  }
  if (sessionLoading || accessCheck.isLoading || me?.user.membershipSelectionRequired) {
    return <div className="aap-home-loading"><Spin /></div>;
  }
  if (!me?.user || me.authState !== 'full') {
    return (
      <Alert
        type="warning"
        showIcon
        message="请先完成登录验证"
        description={<Link to={`/login?${new URLSearchParams({ next: returnPage, appId, target, nonPublicApp: '1' }).toString()}`}>返回登录</Link>}
      />
    );
  }
  if (accessCheck.isError) {
    return (
      <Alert
        type="error"
        showIcon
        message="无法确认应用访问权限"
        description={<Link to="/account">进入个人中心</Link>}
      />
    );
  }
  if (accessCheck.data?.openApp) {
    return <div className="aap-home-loading"><Spin /></div>;
  }

  return (
    <Alert
      type="info"
      showIcon
      message={`应用${appId}属于非公开应用，${countdown} 秒后进入个人中心...`}
      description={(
        <>
          <Typography.Text>你可以前往个人中心管理应用或克隆可用的站内应用。</Typography.Text>
          <div style={{ marginTop: 12 }}>
            <Button type="link" onClick={() => navigate('/account', { replace: true })}>立即进入个人中心</Button>
          </div>
        </>
      )}
    />
  );
}
