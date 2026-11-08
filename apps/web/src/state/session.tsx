/** 会话上下文：me 查询 + 登出；门户 shell 顶栏与各页共用 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { message } from 'antd';
import type { SessionInfo } from '@aap/shared';
import { api } from '../api/client';
import { useNavigate } from 'react-router-dom';

export function useSession() {
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<SessionInfo | null> => {
      try {
        return await api<SessionInfo>('/api/auth/me');
      } catch {
        return null; // 未登录 / 半登录态都按未登录导航处理
      }
    },
    staleTime: 10_000,
    retry: false,
  });
  return { me: q.data ?? null, loading: q.isLoading, refetch: q.refetch };
}

/** 登录成功后的统一跳转：强制改密 → 强制绑 MFA → 默认目标；并刷新会话缓存 */
export function usePostAuthRedirect(destination = '/'): (r: {
  mustChangePassword?: boolean;
  mustEnrollMfa?: boolean;
  membershipSelectionRequired?: boolean;
  user?: { membershipSelectionRequired?: boolean };
}) => void {
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (r) => {
    void qc.invalidateQueries({ queryKey: ['me'] });
    const redirectSuffix = destination === '/' ? '' : `?returnTo=${encodeURIComponent(destination)}`;
    if (r.mustChangePassword) {
      navigate(`/initialize${redirectSuffix}`, { replace: true });
      return;
    }
    if (r.mustEnrollMfa) {
      navigate(`/mfa-setup${redirectSuffix}`, { replace: true });
      return;
    }
    if (r.membershipSelectionRequired ?? r.user?.membershipSelectionRequired) {
      navigate(`/membership-selection?returnTo=${encodeURIComponent(destination)}`, { replace: true });
      return;
    }

    navigate(destination, { replace: true });
  };
}

export function useLogout(): () => Promise<void> {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // 忽略登出错误
    }
    qc.setQueryData(['me'], null);
    void qc.invalidateQueries();
    message.success('已退出登录');
    navigate('/', { replace: true });
  };
}
