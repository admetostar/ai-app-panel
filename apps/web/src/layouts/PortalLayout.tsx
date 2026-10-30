import { Avatar, Button, Dropdown, message, Segmented, Space, theme as antdTheme, type MenuProps } from 'antd';
import { useEffect, useState, type MouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AppstoreOutlined,
  LogoutOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { PortalBootstrap, UserMembershipData } from '@aap/shared';
import { api } from '../api/client';
import { BeianFooter } from '../components/BeianFooter';
import { useSession, useLogout } from '../state/session';
import { userAvatarSrc } from '../lib/userAvatar';
import type { AppCard } from '@aap/shared';
import { TierBadge } from '../components/TierBadge';

type UserPageTheme = 'light' | 'dark' | 'system';
const USER_PAGE_THEME_COOKIE = 'aap_user_page_theme';
const USER_PAGE_THEME_OPTIONS: Array<{ label: string; value: UserPageTheme }> = [
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
  { label: '跟随系统', value: 'system' },
];

function readUserPageTheme(): UserPageTheme {
  const savedTheme = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith(`${USER_PAGE_THEME_COOKIE}=`))
    ?.slice(USER_PAGE_THEME_COOKIE.length + 1);
  return savedTheme === 'dark' || savedTheme === 'system' ? savedTheme : 'light';
}

/**
 * 门户 shell：品牌头（logo/站名/标语）+ 会话区（登录按钮 / 用户菜单含账户信息、主题与导航）+ 备案页脚。
 */
export function PortalLayout() {
  const qc = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api<PortalBootstrap>('/api/portal/bootstrap'),
  });
  const { me } = useSession();
  const logout = useLogout();
  const { token } = antdTheme.useToken();
  const [userPageTheme, setUserPageTheme] = useState<UserPageTheme>(readUserPageTheme);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const membership = useQuery({
    queryKey: ['membership'],
    queryFn: () => api<UserMembershipData>('/api/user/membership'),
    enabled: Boolean(me) && userMenuOpen,
    staleTime: 30_000,
  });

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const updateSystemTheme = () => setSystemPrefersDark(media.matches);
    updateSystemTheme();
    media.addEventListener('change', updateSystemTheme);
    return () => media.removeEventListener('change', updateSystemTheme);
  }, []);

  const branding = data?.branding;
  const isHome = location.pathname === '/';
  const isAuthPage = ['/login', '/register'].includes(location.pathname);
  const isGuidePage = location.pathname === '/guide';
  const isAccountPage = location.pathname === '/account';
  const isMyApplicationsPage = location.pathname === '/my-apps';
  const isLegalPage = ['/terms', '/acceptable-use'].includes(location.pathname);
  const isUserPage = isAccountPage || isMyApplicationsPage;
  useEffect(() => {
    if (me?.user.membershipSelectionRequired && location.pathname !== '/membership-selection') {
      navigate('/membership-selection', { replace: true });
    }
  }, [location.pathname, me?.user.membershipSelectionRequired, navigate]);

  const activeUserPageTheme = userPageTheme === 'system'
    ? systemPrefersDark ? 'dark' : 'light'
    : userPageTheme;
  function changeUserPageTheme(value: UserPageTheme): void {
    setUserPageTheme(value);
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${USER_PAGE_THEME_COOKIE}=${value}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
  }
  async function goToHomeSection(event: MouseEvent<HTMLAnchorElement>, section: string): Promise<void> {
    event.preventDefault();
    try {
      if (section === 'home-applications') {
        const result = await qc.fetchQuery({
          queryKey: ['apps'],
          queryFn: () => api<{ apps: AppCard[] }>('/api/apps'),
        });
        if (!result.apps.some((app) => app.visibility === 'public')) {
          message.info('还没有公开发布的应用，欢迎注册本站后按操作指南发布您的应用创作。');
        }
      }
      if (isHome) {
        document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      navigate(`/#${section}`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '页面内容加载失败');
    }
  }

  const userMenuItems: MenuProps['items'] = [
    { key: 'account', icon: <UserOutlined />, label: '个人中心' },
    { key: 'my-apps', icon: <AppstoreOutlined />, label: '我的应用' },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
    ...(me?.user.role === 'admin' ? [{ type: 'divider' as const }, { key: 'admin', icon: <SettingOutlined />, label: '管理后台' }] : []),
  ];

  return (
    <div
      className={`aap-shell aap-background-shell${isHome ? ' aap-home-shell' : ''}${isGuidePage ? ' aap-guide-shell' : ''}${isAuthPage ? ' aap-auth-shell' : ''}${isAccountPage ? ' aap-account-shell' : ''}${isMyApplicationsPage ? ' aap-my-apps-shell' : ''}${isLegalPage ? ' aap-legal-shell' : ''}${isUserPage ? ' aap-user-page-shell' : ''}`}
      data-user-theme={isUserPage ? activeUserPageTheme : undefined}
    >
      {!isAuthPage ? <header className="aap-header">
        <Link to="/" style={{ textDecoration: 'none' }}>
          <div className="aap-brand">
            {branding?.logo ? (
              <img src={branding.logo} alt={branding.siteName} />
            ) : (
              <span
                style={{
                  display: 'inline-flex',
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  background: token.colorPrimary,
                  color: '#fff',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                }}
              >
                {branding?.siteName?.[0] ?? 'A'}
              </span>
            )}
            <span className="aap-site-name">{branding?.siteName ?? 'AI超级面板'}</span>
          </div>
        </Link>
        {branding?.tagline ? <span className="aap-tagline">{branding.tagline}</span> : null}
        <div style={{ flex: 1 }} />
        <Space className="aap-header-actions" size={20} wrap={false}>
          {isHome ? (
            <nav className="aap-home-nav" aria-label="首页导航">
              <a href="#home-applications" onClick={(event) => void goToHomeSection(event, 'home-applications')}>浏览应用</a>
              <a href="#home-rights" onClick={(event) => void goToHomeSection(event, 'home-rights')}>权益</a>
              <a href="#home-faq" onClick={(event) => void goToHomeSection(event, 'home-faq')}>FAQ</a>
              {!me ? <Link className="aap-home-nav__login" to="/login">登录 <span aria-hidden="true">→</span></Link> : null}
            </nav>
          ) : (
            <Link to="/guide" style={{ fontSize: 13 }}>操作指南</Link>
          )}
          {me ? (
            <Dropdown
              trigger={['click']}
              onOpenChange={setUserMenuOpen}
              menu={{
                items: userMenuItems,
                onClick: ({ key }) => {
                  if (key === 'logout') {
                    void logout();
                    return;
                  }
                  void qc.invalidateQueries();
                  navigate(key === 'admin' ? '/admin' : key === 'my-apps' ? '/my-apps' : '/account');
                },
              }}
              overlayClassName={`aap-user-dropdown aap-user-dropdown--${activeUserPageTheme}`}
              popupRender={(menu) => (
                <div className="aap-user-dropdown__panel">
                  <div className="aap-user-dropdown__identity">
                    <Avatar size={42} src={userAvatarSrc(me.user.avatar, me.user.id)} icon={<UserOutlined />} />
                    <div className="aap-user-dropdown__identity-details">
                      <strong>{me.user.name}</strong>
                      <span>{me.user.email ?? '邮箱未绑定'}</span>
                    </div>
                    <div className="aap-user-dropdown__identity-meta">
                      <div>
                        <span>账号角色</span>
                        <strong>{me.user.role === 'admin' ? '管理员' : '用户'}</strong>
                      </div>
                      <div className="aap-user-dropdown__theme">
                        <span>界面主题</span>
                        <Segmented<UserPageTheme>
                          aria-label="界面主题"
                          value={userPageTheme}
                          onChange={changeUserPageTheme}
                          onClick={(event) => event.stopPropagation()}
                          options={USER_PAGE_THEME_OPTIONS}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="aap-user-dropdown__account">
                    <div>
                      <span>当前方案</span>
                      <div className="aap-user-dropdown__plan">
                        <TierBadge tier={membership.data?.membership?.tier ?? 0} showTierLabel={false} />
                        <strong>
                          {membership.isLoading
                            ? '正在获取…'
                            : membership.isError
                              ? '权益信息暂不可用'
                              : membership.data?.membership?.planName ?? '免费权益'}
                        </strong>
                      </div>
                    </div>
                  </div>
                  <div className="aap-user-dropdown__menu">{menu}</div>
                </div>
              )}
            >
              <Button type="text" className="aap-user-menu" aria-label="用户菜单">
                <Avatar size={30} src={userAvatarSrc(me.user.avatar, me.user.id)} icon={<UserOutlined />} />
                <span>{me.user.name}</span>
              </Button>
            </Dropdown>
          ) : (
            !isHome ? (
              <Button size="small" type="primary" icon={<UserOutlined />} onClick={() => navigate('/login')}>登录</Button>
            ) : null
          )}
        </Space>
      </header> : null}
      <main className={`aap-main${isAuthPage ? ' aap-auth-main' : ''}`}>
        <Outlet context={{ activeUserPageTheme }} />
      </main>
      {branding ? <BeianFooter branding={branding} /> : null}
    </div>
  );
}
