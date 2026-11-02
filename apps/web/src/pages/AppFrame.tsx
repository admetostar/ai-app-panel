/** /open/<id> 兼容页：应用卡片已改为直跳 /app/<id>/（chrome 悬浮条承载门户导航），
 *  旧链接/书签落地此处整页重定向，不再渲染 iframe 包装层。 */
import { Result, Spin } from 'antd';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { withBase } from '../lib/base';
import { useQuery } from '@tanstack/react-query';
import type { PortalBootstrap } from '@aap/shared';
import { api } from '../api/client';
import { appUrl } from '../lib/appUrl';

export function AppFramePage() {
  const { id = '' } = useParams();
  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api<PortalBootstrap>('/api/portal/bootstrap'),
  });

  useEffect(() => {
    if (id && bootstrap.data) window.location.replace(appUrl(id, bootstrap.data.appDomainRoot, bootstrap.data.appPort));
  }, [id, bootstrap.data]);

  if (!id) {
    return <Result status="404" title="应用不存在" extra={<a href={withBase('/')}>返回门户</a>} />;
  }
  return (
    <div style={{ textAlign: 'center', padding: 80 }}>
      <Spin />
      <div style={{ marginTop: 12, color: 'var(--aap-text-secondary)', fontSize: 13 }}>正在打开应用…</div>
    </div>
  );
}
