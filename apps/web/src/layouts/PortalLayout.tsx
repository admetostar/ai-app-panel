import { Avatar, Button, ConfigProvider, Dropdown, message, Segmented, Space, theme as antdTheme, Tooltip, type MenuProps } from 'antd';
import { useEffect, useState, type MouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AppstoreOutlined,
  CrownOutlined,
  ArrowRightOutlined,
  BarChartOutlined,
  SafetyOutlined,
  LogoutOutlined,
  MailOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { PortalBootstrap, UserMembershipData } from '@aap/shared';
import { api } from '../api/client';
import { BeianFooter } from '../components/BeianFooter';
import { useSession, useLogout } from '../state/session';
import { userAvatarSrc } from '../lib/userAvatar';
import type { AppCard } from '@aap/shared';
import { TierBadge } from '../components/TierBadge';
import { InviteIdentityCard } from '../components/InviteIdentityCard';

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [homeHeaderOnHero, setHomeHeaderOnHero] = useState(true);
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
  useEffect(() => {
    document.title = branding?.browserTitle?.trim() || branding?.siteName?.trim() || 'ai-app-panel';

    const existingIcon = document.head.querySelector<HTMLLinkElement>('link[data-aap-site-icon]');
    if (branding?.logo) {
      const icon = existingIcon ?? document.createElement('link');
      icon.rel = 'icon';
      icon.href = branding.logo;
      icon.dataset.aapSiteIcon = 'true';
      if (!existingIcon) document.head.append(icon);
    } else {
      existingIcon?.remove();
    }
  }, [branding?.browserTitle, branding?.logo, branding?.siteName]);

  const isHome = location.pathname === '/';
  const isMembershipSelectionPage = location.pathname === '/membership-selection';
  const isAuthPage = ['/login', '/register'].includes(location.pathname);
  const isGuidePage = location.pathname === '/guide';
  const isAccountPage = location.pathname === '/account';
  const isMyApplicationsPage = location.pathname === '/my-apps';
  const isAdminPage = location.pathname === '/admin';
  const isLegalPage = ['/terms', '/acceptable-use'].includes(location.pathname);
  const isUserPage = isAccountPage || isMyApplicationsPage || isAdminPage;
  useEffect(() => {
    if (!isHome) return;
    let frame = 0;
    const updateHomeHeader = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const onHero = window.scrollY <= 8;
        setHomeHeaderOnHero((current) => current === onHero ? current : onHero);
      });
    };
    updateHomeHeader();
    window.addEventListener('scroll', updateHomeHeader, { passive: true });
    window.addEventListener('resize', updateHomeHeader);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', updateHomeHeader);
      window.removeEventListener('resize', updateHomeHeader);
    };
  }, [isHome]);
  const accountSections = ['myapps', 'profile', 'security', 'benefits', 'plans'] as const;
  const requestedSection = new URLSearchParams(location.search).get('tab');
  const activeSection = isAdminPage
    ? `admin:${requestedSection ?? 'overview'}`
    : isMyApplicationsPage
      ? 'my-apps'
      : requestedSection === 'billing'
        ? 'benefits'
        : accountSections.find((section) => section === requestedSection) ?? 'myapps';
  const userNavGroups = isAdminPage ? [
    {
      key: 'admin',
      label: '管理后台',
      items: [
        { key: 'admin:overview', label: '总览', path: '/admin?tab=overview', icon: <BarChartOutlined /> },
        { key: 'admin:site', label: '站点设置', path: '/admin?tab=site', icon: <SettingOutlined /> },
        { key: 'admin:apps', label: '应用管理', path: '/admin?tab=apps', icon: <AppstoreOutlined /> },
        { key: 'admin:users', label: '用户与注册', path: '/admin?tab=users', icon: <TeamOutlined /> },
        { key: 'admin:security', label: '安全', path: '/admin?tab=security', icon: <SafetyOutlined /> },
        { key: 'admin:mail', label: '通知通道', path: '/admin?tab=mail', icon: <MailOutlined /> },
        { key: 'admin:tls', label: '证书', path: '/admin?tab=tls', icon: <SafetyCertificateOutlined /> },
        { key: 'admin:llm', label: 'LLM 网关', path: '/admin?tab=llm', icon: <RobotOutlined /> },
        { key: 'admin:ops', label: '运营', path: '/admin?tab=ops', icon: <CrownOutlined /> },
      ],
    },
  ] : [
    {
      key: 'apps',
      label: '应用',
      items: [
        { key: 'myapps', label: '应用管理', path: '/account?tab=myapps', icon: <SettingOutlined /> },
        { key: 'my-apps', label: '我的应用', path: '/my-apps', icon: <AppstoreOutlined /> },
      ],
    },
    {
      key: 'account',
      label: '账户和安全',
      items: [
        { key: 'profile', label: '账户信息', path: '/account?tab=profile', icon: <UserOutlined /> },
        { key: 'security', label: '安全管理', path: '/account?tab=security', icon: <SafetyCertificateOutlined /> },
      ],
    },
    {
      key: 'benefits',
      label: '权益中心',
      items: [
        { key: 'benefits', label: '我的权益', path: '/account?tab=benefits', icon: <CrownOutlined /> },
        { key: 'plans', label: '获取权益', path: '/account?tab=plans', icon: <AppstoreOutlined /> },
      ],
    },
  ];
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
  const sidebarMenuItems: MenuProps['items'] = [
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
    ...(me?.user.role === 'admin' ? [{ type: 'divider' as const }, { key: 'admin', icon: <SettingOutlined />, label: '管理后台' }] : []),
  ];

  return (
    <div
      className={`aap-shell aap-background-shell${isHome || isMembershipSelectionPage ? ' aap-home-shell' : ''}${isHome ? ' aap-home-page-shell' : ''}${isGuidePage ? ' aap-guide-shell' : ''}${isAuthPage ? ' aap-auth-shell' : ''}${isAccountPage ? ' aap-account-shell' : ''}${isMyApplicationsPage ? ' aap-my-apps-shell' : ''}${isLegalPage ? ' aap-legal-shell' : ''}${isUserPage ? ' aap-user-page-shell' : ''}${isUserPage && sidebarCollapsed ? ' aap-user-page-shell--sidebar-collapsed' : ''}${isMembershipSelectionPage ? ' aap-membership-selection-shell' : ''}`}
      data-user-theme={isUserPage ? activeUserPageTheme : undefined}
    >
      {isUserPage ? (
        <aside className={`aap-user-sidebar${sidebarCollapsed ? ' aap-user-sidebar--collapsed' : ''}`} aria-label={isAdminPage ? '管理后台导航' : '个人中心导航'}>
          <div className="aap-user-sidebar__top">
            <Link to="/" className="aap-user-sidebar__brand" aria-label={branding?.siteName ?? 'ai-app-panel'}>
              {branding?.logo ? (
                <img src={branding.logo} alt="" />
              ) : (
                <span className="aap-user-sidebar__brand-mark" style={{ background: token.colorPrimary }}>
                  {branding?.siteName?.[0] ?? 'A'}
                </span>
              )}
              <span className="aap-user-sidebar__brand-name">{branding?.siteName ?? 'ai-app-panel'}</span>
            </Link>
            <Button
              type="text"
              className="aap-user-sidebar__toggle"
              aria-label={sidebarCollapsed ? '展开导航' : '折叠导航'}
              title={sidebarCollapsed ? '展开导航' : '折叠导航'}
              icon={sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            />
          </div>

          <nav className="aap-user-sidebar__nav">
            {userNavGroups.map((group) => (
              <section key={group.key} className="aap-user-sidebar__group" aria-label={group.label}>
                <div className="aap-user-sidebar__group-title">
                  <span>{group.label}</span>
                </div>
                {group.items.map((item) => (
                  <Tooltip key={item.key} title={sidebarCollapsed ? item.label : null} placement="right">
                    <button
                      type="button"
                      className={`aap-user-sidebar__item${activeSection === item.key ? ' is-active' : ''}`}
                      aria-label={item.label}
                      aria-current={activeSection === item.key ? 'page' : undefined}
                      onClick={() => {
                        navigate(item.path);
                        if (window.matchMedia('(max-width: 760px)').matches) setSidebarCollapsed(true);
                      }}
                    >
                      <span className="aap-user-sidebar__item-icon">{item.icon}</span>
                      <span className="aap-user-sidebar__item-label">{item.label}</span>
                    </button>
                  </Tooltip>
                ))}
              </section>
            ))}
          </nav>

          <div className="aap-user-sidebar__bottom">
            {me ? (
              <Dropdown
                trigger={['click']}
                onOpenChange={setUserMenuOpen}
                menu={{
                  items: sidebarMenuItems,
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
                    <InviteIdentityCard
                      open={userMenuOpen}
                      siteName={branding?.siteName ?? 'ai-app-panel'}
                      logo={branding?.logo ?? null}
                      userName={me.user.name}
                      theme={activeUserPageTheme}
                    />
                  </div>
                )}
              >
                <button type="button" className="aap-user-sidebar__profile" title={sidebarCollapsed ? me.user.name : undefined}>
                  <Avatar size={34} src={userAvatarSrc(me.user.avatar, me.user.id)} icon={<UserOutlined />} />
                  <span className="aap-user-sidebar__profile-name">{me.user.name}</span>
                </button>
              </Dropdown>
            ) : null}
          </div>
        </aside>
      ) : null}
      {!isAuthPage && !isUserPage ? <header className={`aap-header${isHome ? ` aap-home-header ${homeHeaderOnHero ? 'aap-home-header--hero' : 'aap-home-header--content'}` : ''}`}>
        <div className={`aap-header__contents${isHome ? ' aap-header__inner' : ''}`}>
        <Link to="/" style={{ textDecoration: 'none' }}>
          <div className="aap-brand">
            {branding?.logo ? (
              <img src={branding.logo} alt={branding.siteName} />
            ) : (
              <span className="aap-brand-mark" style={{ background: token.colorPrimary }}>
                {branding?.siteName?.[0] ?? 'A'}
              </span>
            )}
            <span className="aap-site-name">{branding?.siteName ?? 'ai-app-panel'}</span>
          </div>
        </Link>
        {branding?.tagline ? <span className="aap-tagline">{branding.tagline}</span> : null}
        <div style={{ flex: 1 }} />
        <Space className="aap-header-actions" size={20} wrap={false}>
          {isHome ? (
            <nav className="aap-home-nav" aria-label="首页导航">
              <a
                href="#home-applications"
                onClick={(event) => void goToHomeSection(event, 'home-applications')}
              >
                发现应用
              </a>
              <a
                href="#home-rights"
                onClick={(event) => void goToHomeSection(event, 'home-rights')}
              >
                权益
              </a>
              <a
                href="#home-faq"
                onClick={(event) => void goToHomeSection(event, 'home-faq')}
              >
                FAQ
              </a>
              {!me ? (
                <Button
                  size="small"
                  type="primary"
                  className="aap-header-login"
                  icon={<ArrowRightOutlined />}
                  onClick={() => navigate('/login')}
                >
                  登录
                </Button>
              ) : null}
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
                  if (key === 'account') {
                    navigate('/account');
                  } else if (key === 'my-apps') {
                    navigate('/my-apps');
                  } else if (key === 'admin') {
                    navigate('/admin');
                  }
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
                  <InviteIdentityCard
                    open={userMenuOpen}
                    siteName={branding?.siteName ?? 'ai-app-panel'}
                    logo={branding?.logo ?? null}
                    userName={me.user.name}
                    theme={activeUserPageTheme}
                  />
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
              <Button
                size="small"
                type="primary"
                className="aap-header-login"
                icon={<ArrowRightOutlined />}
                onClick={() => navigate('/login')}
              >
                登录
              </Button>
            ) : null
          )}
        </Space>
        </div>
      </header> : null}
      <main className={`aap-main${isAuthPage ? ' aap-auth-main' : ''}${isUserPage ? ' aap-user-main' : ''}`}>
        {isUserPage && sidebarCollapsed ? (
          <Button
            type="text"
            className="aap-user-sidebar-open"
            aria-label="展开导航"
            title="展开导航"
            icon={<MenuUnfoldOutlined />}
            onClick={() => setSidebarCollapsed(false)}
          />
        ) : null}
        {isAdminPage ? (
          <ConfigProvider
            theme={{
              algorithm: activeUserPageTheme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
              token: activeUserPageTheme === 'dark'
                ? {
                    colorPrimary: '#4c8dff',
                    colorInfo: '#4c8dff',
                    colorBgBase: '#14171c',
                    colorBgContainer: '#1d2129',
                    colorBgElevated: '#23272f',
                    colorTextBase: '#e6e8ec',
                    colorText: '#e6e8ec',
                    colorTextSecondary: '#aeb6c4',
                    colorBorder: '#414754',
                    colorBorderSecondary: '#2e333d',
                  }
                : undefined,
            }}
          >
            <Outlet context={{ activeUserPageTheme }} />
          </ConfigProvider>
        ) : (
          <Outlet context={{ activeUserPageTheme }} />
        )}
      </main>
      {branding ? <BeianFooter branding={branding} /> : null}
    </div>
  );
}
