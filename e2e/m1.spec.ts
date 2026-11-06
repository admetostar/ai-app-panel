import { test, expect } from '@playwright/test';
import { generate } from 'otplib';
import { readFile } from 'node:fs/promises';
import { bytesToBase64 } from '../apps/web/src/lib/base64';
import {
  INIT_ADMIN_PASSWORD,
  ADMIN_NEW_PASSWORD,
  NORMAL_USERNAME,
  NORMAL_INIT_PASSWORD,
  PORTAL,
  latestCodeFromLog,
  runDatabaseQuery,
} from './global-setup';

const NORMAL_NEW_PASSWORD = 'E2e-normal-password-123';

/** 测试间共享（workers=1 串行，同一进程模块状态保留） */
let adminTotpSecret = '';
/** 链路③已消费的 TOTP 窗口计数（服务端重放保护以此为下界） */
let lastUsedTotpWindow = 0;

test('大文件 Base64 编码分块执行，不触发调用栈溢出', () => {
  const input = Uint8Array.from({ length: 1_000_000 }, (_, index) => index % 256);
  const encoded = bytesToBase64(input);
  expect(Buffer.from(encoded, 'base64')).toEqual(Buffer.from(input));
});

test('首页导航定位与登录注册分栏页面', async ({ page }) => {
  await page.goto('/');
  const plansResponse = await page.request.get(`${PORTAL}/api/portal/plans`);
  expect(plansResponse.ok()).toBe(true);
  expect((await plansResponse.json()).plans).toBeInstanceOf(Array);
  await expect(page.locator('.aap-home-title')).toBeVisible();
  await expect(page.locator('.aap-home-title')).toContainText('使用ai-app-panel零代码创作个人软件');
  await expect(page.locator('.aap-home-description')).toContainText('ai-app-panel 是一个个人AI应用的运行工具');
  await expect(page.locator('.aap-home-description')).toContainText('上传到ai-app-panel向其他人展示您的创作');
  await expect(page.locator('.aap-home-shell .aap-header')).toHaveCSS('backdrop-filter', 'blur(18px)');
  await expect(page.locator('.aap-home-kicker')).toHaveText('ai-app-panel');
  await expect(page.locator('.aap-home-hero .aap-home-search')).toHaveCount(0);
  await expect(page.getByPlaceholder('搜索应用名称或介绍')).toBeVisible();
  await expect(page.locator('.aap-home-search .ant-input')).toHaveCSS('color', 'rgb(16, 24, 40)');
  expect(
    await page.locator('.aap-home-search .ant-input').evaluate((input) => getComputedStyle(input, '::placeholder').color),
  ).toBe('rgb(71, 84, 103)');
  const homeNav = page.locator('.aap-home-nav');
  await expect(homeNav.getByRole('link', { name: '发现应用' })).toBeVisible();
  const homeHeader = page.locator('.aap-home-page-shell .aap-header');
  const homeFooter = page.locator('.aap-home-page-shell .aap-footer__inner');
  const heroBounds = await page.locator('.aap-home-hero').boundingBox();
  const headerBounds = await page.locator('.aap-header__inner').boundingBox();
  const footerBounds = await homeFooter.boundingBox();
  if (!heroBounds || !headerBounds || !footerBounds) throw new Error('首页对齐元素未渲染');
  await expect(homeFooter).toHaveCSS('text-align', 'center');
  expect(Math.abs(heroBounds.x - headerBounds.x)).toBeLessThan(2);
  expect(Math.abs(heroBounds.x - footerBounds.x)).toBeLessThan(2);
  expect(Math.abs(heroBounds.width - headerBounds.width)).toBeLessThan(2);
  expect(Math.abs(heroBounds.width - footerBounds.width)).toBeLessThan(2);
  const loginButton = homeNav.getByRole('button', { name: /登录/ });
  await expect(homeHeader).toHaveCSS('position', 'fixed');
  await expect(homeHeader).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.92)');
  await expect(homeNav.getByRole('link', { name: '发现应用' })).toHaveCSS('color', 'rgb(71, 84, 103)');
  await expect(loginButton).toHaveCSS('background-color', 'rgb(49, 92, 245)');
  await expect(loginButton).toHaveCSS('color', 'rgb(255, 255, 255)');
  expect(
    await homeNav.evaluate((nav) => Number.parseFloat(getComputedStyle(nav).columnGap)),
  ).toBeGreaterThanOrEqual(20);

  const rightsLink = homeNav.getByRole('link', { name: '权益' });
  await rightsLink.click();
  await expect(page.locator('#home-rights')).toBeInViewport();
  await expect(rightsLink).toHaveCSS('color', 'rgb(23, 92, 211)');
  await expect(homeHeader).toHaveCSS('top', '0px');
  await expect(homeHeader).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.96)');
  await expect(homeHeader).toHaveCSS('backdrop-filter', 'blur(18px)');
  await expect(loginButton).toHaveCSS('background-color', 'rgb(49, 92, 245)');
  await expect(loginButton).toHaveCSS('color', 'rgb(255, 255, 255)');
  const faqLink = homeNav.getByRole('link', { name: 'FAQ' });
  await faqLink.click();
  await expect(page.locator('#home-faq')).toBeInViewport();
  await expect(page.locator('.aap-home-faq .ant-collapse-header').first()).toHaveCSS('color', 'rgb(16, 24, 40)');
  await page.locator('.aap-home-faq .ant-collapse-header').first().click();
  await expect(page.locator('.aap-home-faq .ant-collapse-content-box').first()).toHaveCSS('color', 'rgb(52, 64, 84)');
  await expect(page.locator('.aap-home-faq .ant-collapse-header').first()).toHaveCSS('color', 'rgb(16, 24, 40)');
  await page.locator('.aap-home-faq .ant-collapse-header').first().click();
  await expect(page.locator('.aap-home-faq .ant-collapse-content-box').first()).toHaveCSS('color', 'rgb(52, 64, 84)');

  await page.locator('.aap-home-hero__cta').click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await page.locator('.aap-home-hero__guide').click();
  await expect(page).toHaveURL(/\/guide$/);
  await expect(page.locator('.aap-guide-progress li')).toHaveCount(5);
  for (const chapter of ['二', '三', '四', '五']) {
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.locator('.aap-guide-step__topline')).toContainText(`章节 ${chapter}`);
  }
  await page.getByRole('button', { name: '完成，前往登录 / 注册' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto('/login');
  const authPanel = page.locator('.aap-auth-panel');
  const authArt = page.locator('.aap-auth-art');
  await expect(authArt).toHaveCSS('background-image', /login/);
  const imageArea = await authArt.boundingBox();
  const panelArea = await authPanel.boundingBox();
  expect(imageArea && panelArea && imageArea.width > 0 && Math.abs(imageArea.height - panelArea.height) < 2).toBe(true);
  expect(imageArea && panelArea && imageArea.x === panelArea.x && panelArea.x === 0).toBe(true);
  expect(panelArea && Math.abs(panelArea.width - 1280) < 2).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.aap-home-nav')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('.aap-home-nav').getByRole('button', { name: /登录/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('.aap-auth-art')).toHaveCSS('background-image', /login/);
  await expect(page.getByRole('button', { name: /^登\s*录$/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Terms of Service' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Acceptable Use Policy' })).toBeVisible();
  await expect(page.locator('footer.aap-footer')).toBeVisible();
  await page.goto('/terms');
  await expect(page.locator('.aap-legal-shell')).toBeVisible();
  await expect(page.locator('.aap-legal-page .ant-card')).toHaveCount(0);
  await expect(page.locator('.aap-legal-shell .aap-header')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.08)');
  await expect(page.locator('.aap-legal-shell .aap-header')).toHaveCSS('backdrop-filter', 'blur(20px)');
  await page.goto('/guide');
  await expect(page.locator('.aap-header')).toHaveCSS('backdrop-filter', 'blur(20px)');
  await page.goto('/login');
  await expect(page.locator('.aap-auth-art')).toBeHidden();
  await page.getByRole('link', { name: '注册账号' }).click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.locator('.aap-auth-content')).toBeVisible();
  await expect(page.locator('.aap-auth-art')).toBeHidden();
  await page.goto('/register?invite=E2E-INVITE-CODE');
  await expect(page.locator('#inviteCode')).toHaveValue('E2E-INVITE-CODE');
});

test('首页标题与介绍中的站点名称跟随品牌设置', async ({ page }) => {
  await page.route('**/api/portal/bootstrap', async (route) => {
    const response = await route.fetch();
    const bootstrap = await response.json() as {
      branding: { siteName: string; browserTitle: string; logo: string | null };
    };
    bootstrap.branding.siteName = '运营站点名称';
    bootstrap.branding.browserTitle = '自定义浏览器标题';
    bootstrap.branding.logo = '/site-logo-from-branding.png';
    await route.fulfill({ response, json: bootstrap });
  });

  await page.goto('/');
  await expect(page).toHaveTitle('自定义浏览器标题');
  await expect(page.locator('link[data-aap-site-icon]')).toHaveAttribute('href', '/site-logo-from-branding.png');
  await expect(page.locator('.aap-home-kicker')).toHaveText('运营站点名称');
  await expect(page.locator('.aap-home-title')).toContainText('使用运营站点名称零代码创作个人软件');
  await expect(page.locator('.aap-home-description')).toContainText('运营站点名称 是一个个人AI应用的运行工具');
  await expect(page.locator('.aap-home-description')).toContainText('上传到运营站点名称向其他人展示您的创作');
});

test('发现应用与我的应用卡片悬浮展示访问二维码', async ({ page }) => {
  const app = {
    id: 'qr-demo',
    name: '二维码演示',
    description: '悬浮显示访问二维码',
    icon: null,
    category: '测试',
    visibility: 'public',
    accessible: true,
    status: 'ok',
    sort: 0,
    kind: 'upstream',
  };
  await page.route('**/api/portal/bootstrap', (route) => route.fulfill({
    json: {
      branding: {
        siteName: 'QR 测试站点',
        tagline: '',
        logo: null,
        themeId: 'default',
        accentColor: null,
        footerText: '',
        icpNumber: null,
        policeNumber: null,
      },
      appDomainRoot: 'localhost',
      appPort: null,
      registration: { mode: 'open', turnstileEnabled: false },
      needsInit: false,
      oidc: { enabled: false },
    },
  }));
  await page.route('**/api/apps', (route) => route.fulfill({ json: { apps: [app] } }));
  await page.route('**/api/apps/mine', (route) => route.fulfill({ json: { apps: [app] } }));
  await page.route('**/api/apps/shared', (route) => route.fulfill({ json: { apps: [app] } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({
    json: {
      user: {
        id: 8,
        kind: 'local',
        username: 'qr-user',
        email: null,
        phone: null,
        name: '二维码用户',
        avatar: null,
        role: 'user',
        status: 'active',
        mfaEnabled: false,
        plan: 'free',
        membershipSelectionRequired: false,
        createdAt: Date.now(),
      },
      authState: 'full',
      stepUpUntil: null,
      mustChangePassword: false,
      mustEnrollMfa: false,
    },
  }));

  for (const path of ['/#home-applications', '/my-apps']) {
    await page.goto(path);
    const cardLink = page.locator('.aap-home-app-grid .aap-app-card-link').first();
    await expect(cardLink).toHaveAttribute('href', `${PORTAL}/app/qr-demo/`);
    const card = cardLink.locator('.aap-app-card');
    await expect(card).toContainText('二维码演示');
    await expect(card).not.toContainText('打开 →');
    await card.hover();
    await expect(card.locator('.aap-app-card__qr-drawer')).toHaveCSS('opacity', '1');
    await expect(card.locator('.aap-app-card__qr-frame img')).toHaveAttribute('alt', '二维码演示访问二维码');
  }
});

test('站内共享只提供克隆入口，不显示无效访问二维码', async ({ page }) => {
  const siteApp = {
    id: 'site-shared-demo',
    name: '站内共享应用',
    description: '只能克隆后访问',
    icon: null,
    category: '测试',
    visibility: 'login',
    accessible: false,
    status: 'ok',
    sort: 0,
    kind: 'html',
    runtimeMode: null,
  };
  await page.route('**/api/auth/me', (route) => route.fulfill({
    json: {
      user: {
        id: 8,
        kind: 'local',
        username: 'clone-user',
        email: null,
        phone: null,
        name: '克隆用户',
        avatar: null,
        role: 'user',
        status: 'active',
        mfaEnabled: false,
        plan: 'member',
        membershipSelectionRequired: false,
        createdAt: Date.now(),
      },
      authState: 'full',
      stepUpUntil: null,
      mustChangePassword: false,
      mustEnrollMfa: false,
    },
  }));
  await page.route('**/api/apps/mine', (route) => route.fulfill({ json: { apps: [] } }));
  await page.route('**/api/apps/shared', (route) => route.fulfill({ json: { apps: [] } }));
  await page.route('**/api/apps/site-shared', (route) => route.fulfill({ json: { apps: [siteApp] } }));
  await page.route('**/api/user/membership', (route) => route.fulfill({
    json: { membership: { appCloneLimit: 2, appsCloned: 0, remainingCloneApps: 2 } },
  }));
  await page.route('**/api/portal/bootstrap', (route) => route.fulfill({
    json: {
      branding: { siteName: '测试站点', tagline: '', logo: null, themeId: 'default', accentColor: null, footerText: '', icpNumber: null, policeNumber: null },
      appDomainRoot: 'localhost',
      appPort: null,
      registration: { mode: 'open', turnstileEnabled: false },
      needsInit: false,
      oidc: { enabled: false },
    },
  }));
  let cloneRequested = false;
  await page.route(/\/api\/apps\/site-shared-demo\/clone(?:\?.*)?$/, async (route) => {
    cloneRequested = route.request().method() === 'POST';
    await route.fulfill({ status: 201, json: { ok: true, id: 'clone-demo' } });
  });

  await page.goto('/my-apps');
  await expect(page.getByRole('heading', { name: '站内共享' })).toBeVisible();
  await expect(page.locator('.aap-home-category').filter({ hasText: '站内共享应用' }).first()).toContainText('只能克隆后访问');
  const card = page.locator('.aap-app-card').filter({ hasText: '站内共享应用' });
  await expect(card.locator('.aap-app-card__qr-drawer')).toHaveCount(0);
  const cloneButton = card.getByRole('button', { name: /^克\s*隆$/ });
  await cloneButton.click();
  await expect.poll(() => cloneRequested).toBe(true);
  await expect(page.getByText('已将「站内共享应用」克隆到我自己的应用')).toBeVisible();
});

test('订阅详情使用 T 形账单并突出数字', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({
    json: {
      user: {
        id: 8,
        kind: 'local',
        username: 'billing-user',
        email: null,
        phone: null,
        name: '账单测试用户',
        avatar: null,
        role: 'user',
        status: 'active',
        mfaEnabled: false,
        plan: 'free',
        membershipSelectionRequired: false,
        createdAt: Date.now(),
      },
      authState: 'full',
      stepUpUntil: null,
      mustChangePassword: false,
      mustEnrollMfa: false,
    },
  }));
  await page.route('**/api/user/membership', (route) => route.fulfill({
    json: {
      membership: null,
      tokenBalance: 0,
      pointsBalance: 1500,
      plans: [{
        id: 12,
        name: '测试权益包',
        groupName: '进阶组',
        durationDays: 90,
        priceCurrency: 'POINTS',
        priceFen: 0,
        priceCents: 0,
        pricePoints: 300,
        redeemUrl: null,
        tokenGrant: 10000,
        tier: 2,
        appUploadLimit: 15,
        appCloneLimit: 0,
        enabled: true,
      }],
      orders: [],
    },
  }));
  await page.route('**/api/user/billing', (route) => route.fulfill({
    json: { showTopupPanel: false, showOrdersPanel: false },
  }));
  await page.goto('/account?tab=plans');
  await expect(page.locator('.membership-plan-option__details')).toContainText('—');
  await page.locator('.membership-plan-option').getByRole('button', { name: /获\s*取/ }).click();

  const dialog = page.locator('.aap-account-modal .ant-modal');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.ant-modal-title')).toHaveText('订阅详情');
  const bill = dialog.locator('.aap-subscription-bill');
  await expect(bill.locator('.aap-subscription-bill__details > div')).toHaveCount(5);
  expect(
    await bill.locator('.aap-subscription-bill__details').evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(' ').length),
  ).toBe(2);
  await expect(bill.locator('.aap-subscription-bill__total > span')).toHaveCSS('font-size', '29px');
  await expect(bill.locator('.aap-subscription-bill__details > div > strong').first()).toHaveCSS('font-size', '19px');
  await expect(dialog.locator('.ant-tag, .aap-tier-badge')).toHaveCount(0);
  await expect(dialog).toContainText('需支付');
  await expect(dialog).toContainText('300');
  await expect(dialog).toContainText('1,500');
});

test('用户菜单内的邀请码卡片同步站点品牌', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => localStorage.setItem('e2e-copied-invite-link', text) },
    });
  });
  const logo = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23f3cc6d'/%3E%3C/svg%3E";
  await page.route('**/api/portal/bootstrap', async (route) => {
    const response = await route.fetch();
    const bootstrap = await response.json() as {
      branding: { siteName: string; logo: string | null };
      registration: { verificationChannel: 'email' | 'phone' };
    };
    bootstrap.branding.siteName = '邀请测试站点';
    bootstrap.branding.logo = logo;
    bootstrap.registration.verificationChannel = 'phone';
    await route.fulfill({ response, json: bootstrap });
  });
  await page.route('**/api/auth/me', (route) => route.fulfill({
    json: {
      user: {
        id: 1,
        kind: 'local',
        username: 'invite-test',
        email: null,
        phone: null,
        name: '邀请测试用户',
        avatar: null,
        role: 'user',
        status: 'active',
        mfaEnabled: false,
        plan: 'free',
        membershipSelectionRequired: false,
        createdAt: Date.now(),
      },
      authState: 'full',
      stepUpUntil: null,
      mustChangePassword: false,
      mustEnrollMfa: false,
    },
  }));
  await page.route('**/api/user/membership', (route) => route.fulfill({
    json: { membership: null, tokenBalance: 0, pointsBalance: 0, plans: [], orders: [] },
  }));
  await page.route('**/api/user/invite', (route) => route.fulfill({
    json: { code: 'E2E-INVITE-CODE', useCount: 3 },
  }));

  await page.goto('/');
  await page.getByRole('button', { name: '用户菜单' }).click();

  const card = page.getByRole('button', { name: '点击复制邀请链接' });
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/aap-id-card--light/);
  await expect(card.locator('.aap-id-card__site-name')).toHaveText('邀请测试站点');
  await expect(card.locator('.aap-id-card__brand img')).toHaveAttribute('src', logo);
  await expect(card.locator('.aap-id-card__qr img')).toBeVisible();
  await expect(card).toHaveAttribute('title', '点击复制邀请链接');
  await card.click();
  await expect(page.locator('.ant-message-notice')).toContainText('邀请注册链接已复制');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('e2e-copied-invite-link')))
    .toContain('/register?channel=phone&invite=E2E-INVITE-CODE');
  await page.locator('.aap-user-dropdown__theme .ant-segmented-item').filter({ hasText: '深色' }).click();
  await expect(card).toHaveClass(/aap-id-card--dark/);
  await page.locator('.aap-user-dropdown__theme .ant-segmented-item').filter({ hasText: '浅色' }).click();
  await expect(card).toHaveClass(/aap-id-card--light/);

  await page.goto('/account?tab=profile');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出邀请电子卡' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('invite-identity-card.png');
  const png = await readFile(await download.path());
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  await expect(page.locator('.ant-message-notice')).toContainText('邀请电子卡 PNG 已导出');

  await page.goto('/register?channel=phone&invite=E2E-INVITE-CODE');
  const inviteCode = page.getByLabel('邀请码（选填）');
  await expect(inviteCode).toBeVisible();
  await expect(inviteCode).toHaveValue('E2E-INVITE-CODE');

  await page.goto('/login');
  await expect(page.getByPlaceholder('手机号 / 用户名 / 邮箱')).toBeVisible();
});

/** M1 验收主链路①：F3 初始化——初始密码登录 → 强制改密 → 强制绑 MFA → 完成向导 */
test('F3 初始化：改密 → 绑定 TOTP → 进入个人中心', async ({ page }) => {
  // 初始密码登录（global-setup 已创建 admin，故直接登录触发强制流程）
  await page.goto('/login');
  await page.getByPlaceholder('用户名').fill('admin');
  await page.getByPlaceholder('密码').fill(INIT_ADMIN_PASSWORD);
  await page.getByRole('button', { name: /^登\s*录$/ }).click();

  // 强制改密（三处密码输入：当前/新/确认）
  await page.waitForURL('**/initialize**');
  await page.locator('input[type="password"]').nth(0).fill(INIT_ADMIN_PASSWORD);
  await page.locator('input[type="password"]').nth(1).fill(ADMIN_NEW_PASSWORD);
  await page.locator('input[type="password"]').nth(2).fill(ADMIN_NEW_PASSWORD);
  await page.getByRole('button', { name: '保存并继续' }).click();

  // 强制绑定 MFA：读取页面展示的 TOTP 密钥，本地算即时码确认
  await page.waitForURL('**/mfa-setup**');
  const secretEl = page.getByText(/^[A-Z2-7]{16,}$/);
  await expect(secretEl).toBeVisible();
  adminTotpSecret = (await secretEl.textContent())!.trim();
  const code = await generate({ secret: adminTotpSecret });
  await page.getByPlaceholder('123456').fill(code);
  await page.getByRole('button', { name: '确认绑定' }).click();

  // 恢复码出示 → 完成
  await expect(page.getByText('请保存恢复码')).toBeVisible();
  await page.getByRole('button', { name: '我已保存，完成' }).click();
  await page.waitForURL(`${PORTAL}/account`);

  // 登录流程最终进入个人中心，且用户菜单显示管理入口与退出登录
  await expect(page.getByRole('heading', { name: '个人中心' })).toBeVisible();
  await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible();
  await page.getByRole('button', { name: '用户菜单' }).click();
  await expect(page.locator('.aap-user-dropdown__panel')).toHaveCSS('background-color', 'rgb(248, 250, 252)');
  await expect(page.locator('.aap-user-dropdown__identity')).toContainText('管理员');
  await expect(page.locator('.aap-user-dropdown__account')).toContainText('当前方案');
  await expect(page.locator('.aap-user-dropdown__theme')).toContainText('界面主题');
  await expect(page.getByRole('radio', { name: '浅色' })).toBeChecked();
  for (const option of await page.locator('.aap-user-dropdown__theme .ant-segmented-item').all()) {
    const textFits = await option.evaluate((element) => element.scrollWidth <= element.clientWidth);
    expect(textFits).toBe(true);
  }
  const membershipResponse = await page.request.get(`${PORTAL}/api/user/membership`);
  const membership = (await membershipResponse.json()) as { membership: { planName: string } | null };
  await expect(page.locator('.aap-user-dropdown__account')).toContainText(membership.membership?.planName ?? '免费权益');
  await expect(page.getByRole('menuitem', { name: '管理后台' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '我的应用' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '个人中心' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '账号电子身份卡' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '退出登录' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '应用管理' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '账户安全' })).toHaveCount(0);
  const identityCard = page.getByRole('button', { name: '点击复制邀请链接' });
  await expect(identityCard).toBeVisible();
  await expect(identityCard).toContainText('专属邀请码');
  await expect(identityCard.locator('.aap-id-card__site-name')).toHaveText('ai-app-panel');
  await expect(identityCard.locator('.aap-id-card__qr img')).toBeVisible();
  await identityCard.hover();
  await expect(page.getByRole('tooltip')).toHaveText('点击复制邀请链接');
  await page.getByRole('button', { name: '用户菜单' }).click();
  await page.locator('.aap-user-dropdown__theme .ant-segmented-item').filter({ hasText: '深色' }).click();
  await expect(page.locator('.aap-account-shell')).toHaveAttribute('data-user-theme', 'dark');
  await page.getByRole('menuitem', { name: '我的应用' }).click();
  await page.waitForURL('**/my-apps');
  await expect(page.getByRole('heading', { name: '我的应用' })).toBeVisible();
  await expect(page.locator('.aap-my-apps-shell')).toHaveAttribute('data-user-theme', 'dark');
  await expect(page.locator('.aap-my-apps-page')).toHaveCSS('background-color', 'rgb(20, 23, 28)');
  await expect(page.getByText('还没有创建或上传应用。前往应用管理上传 .awpk 包，开始发布你的创作。')).toBeVisible();
  await page.reload();
  await expect(page.locator('.aap-my-apps-shell')).toHaveAttribute('data-user-theme', 'dark');
  await expect(page.locator('.aap-my-apps-page')).toHaveCSS('background-color', 'rgb(20, 23, 28)');
});

/** M1 验收主链路②：注册 → 必选权益 → 卡片墙 → 打开应用 */
test('注册用户选择权益 → 卡片墙 → 打开演示应用', async ({ page }) => {
  await page.goto('/register');
  await page.locator('#username').fill('e2euser');
  await page.locator('#password').fill('E2e-password-123');
  await page.locator('#password2').fill('E2e-password-123');
  await page.locator('#email').fill('e2euser@example.com');
  await page.getByRole('button', { name: '获取邮箱验证码' }).click();
  await expect(page.getByPlaceholder('6 位验证码')).toBeVisible({ timeout: 30_000 });

  // 验证码走服务端日志兜底通道
  const code = latestCodeFromLog();
  await page.getByPlaceholder('6 位验证码').fill(code);
  await page.getByRole('button', { name: '完成注册' }).click();

  // 注册后先选择权益，免费权益立即生效
  await page.waitForURL(`${PORTAL}/membership-selection`);
  await page.getByRole('button', { name: /获\s*取/ }).click();
  await page.waitForURL(`${PORTAL}/account`);
  await page.goto('/');
  await expect(page.getByText('演示应用')).toBeVisible();
  await expect(page.getByRole('dialog', { name: /操作指南/ })).not.toBeVisible();

  // 打开应用：卡片整页直跳 /app/<id>/（b3663a9 起无 iframe 包装，门户导航由注入 chrome 承载）
  await page.getByText('演示应用').first().click();
  await expect(page.locator('#upstream-marker')).toHaveText('DEMO-UPSTREAM-OK');
});

test('操作导航可跳过并进入登录页面', async ({ page }) => {
  await page.goto('/guide');
  await expect(page.locator('.aap-guide-step')).toBeVisible();
  await page.getByRole('button', { name: '跳过' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('操作导航按一至五分章展示且章节标题不重复标注步骤号', async ({ page }) => {
  const chapters = [
    '一、什么是 ai-app-panel',
    '二、安装开发技能',
    '三、让 Agent 做出你的应用',
    '四、上传到 ai-app-panel',
    '五、选择应用的可见范围',
  ];

  await page.goto('/guide');
  for (const [index, title] of chapters.entries()) {
    await expect(page.locator('.aap-guide-markdown h2')).toHaveText(title);
    await expect(page.locator('.aap-guide-markdown')).not.toContainText('**');
    await expect(page.locator('.aap-guide-step__topline')).toContainText(`章节 ${['一', '二', '三', '四', '五'][index]}`);
    if (index < chapters.length - 1) {
      await page.getByRole('button', { name: '下一步' }).click();
    }
  }
});

test('操作导航文案无裸露 Markdown 且按章节展示应用示例和配置说明', async ({ page }) => {
  await page.goto('/guide');
  const guideContent = page.locator('.aap-guide-markdown');

  await expect(guideContent).not.toContainText('**');
  await expect(guideContent).not.toContainText('`');
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(guideContent.getByRole('heading', { name: 'WorkBuddy' })).toBeVisible();
  await expect(guideContent.getByRole('heading', { name: 'Claude' })).toBeVisible();
  await expect(guideContent).not.toContainText('**');
  await expect(guideContent).not.toContainText('`');
  await expect(guideContent).toContainText('使用您习惯的Agent安装awpk-app-develop.skill或awpk-app-develop.zip技能包');
  await expect(guideContent).toContainText('「专家·技能·连接器」的「技能」页面点击「添加技能」按钮');
  await expect(guideContent).toContainText('自动安全检验后点击安装');
  await expect(guideContent).toContainText('「自定义」的「Skills」页面点击「添加」按钮');
  await expect(guideContent).toContainText('「设置」的「功能」页面打开「代码执行和文件创建」');
  await expect(guideContent).toContainText('你知道awpk应用吗？');
  await expect(guideContent).not.toContainText('.awpk');
  await expect(guideContent).not.toContainText('指定范围');
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(guideContent.getByRole('heading', { name: '告诉 Agent 你要一个什么应用' })).toBeVisible();
  await expect(
    guideContent.getByText('写一个五子棋应用打包成awpk。'),
  ).toBeVisible();
  await expect(guideContent).not.toContainText('**');
  await expect(guideContent).not.toContainText('`');
  await expect(guideContent.getByText('写一个awpk应用，功能是把excel表格数据转换成json结构化数据。')).toBeVisible();
  await expect(guideContent.getByText('写一个使用个人照片一键生成卡通形象的AWPK应用。')).toBeVisible();
  await expect(guideContent.getByText('开发一个个人相册，打包成awpk。')).toBeVisible();
  await expect(guideContent).not.toContainText('环境变量');
  await expect(guideContent).not.toContainText('入参');

  await page.getByRole('button', { name: '下一步' }).click();
  await expect(guideContent).toContainText('环境变量');
  await expect(guideContent).toContainText('填写所需入参');
  await expect(guideContent).toContainText('「用户中心」的「应用管理」板块');
  await expect(guideContent).not.toContainText('“应用管理”');
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(guideContent).toContainText('「我的应用 → 站内共享」');
  await expect(guideContent).not.toContainText('“我的应用”');
});

/** M1 验收主链路③：退出 → 新密码登录 → TOTP 挑战 → 完整会话 */
test('退出登录 → 新密码 + TOTP 重新登录', async ({ page }) => {
  test.skip(!adminTotpSecret, '依赖链路①产出的 TOTP 密钥');
  await page.goto('/login');
  await page.getByPlaceholder('用户名').fill('admin');
  await page.getByPlaceholder('密码').fill(ADMIN_NEW_PASSWORD);
  await page.getByRole('button', { name: /^登\s*录$/ }).click();

  // MFA 挑战页（password_ok → full）
  await expect(page.getByText('已验证密码，请完成多因子认证')).toBeVisible();
  // 取「下一窗口」的码：链路①的确认已消耗当前窗口（服务端重放保护正确拒绝
  // 同窗口复用），±1 窗口容忍内取 C+1，计数器更新鲜、合法非重放
  const nextWindow = Math.floor(Date.now() / 1000 / 30) + 1;
  lastUsedTotpWindow = nextWindow; // 供链路④避开重放窗口
  const code = await generate({ secret: adminTotpSecret, epoch: nextWindow * 30 });
  await page.getByPlaceholder('6 位验证码或恢复码 xxxx-xxxx').fill(code);
  await page.getByRole('button', { name: /^验\s*证$/ }).click();

  await page.waitForURL(`${PORTAL}/account`);
  await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible();
  await page.goto('/');
  await expect(page.locator('.aap-home-nav__login')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible();
  await expect(page.getByRole('button', { name: '用户菜单' })).toHaveCSS('border-radius', '0px');
});

/** E2 管理后台回归：设置开关保存必须真实落库（回归：SettingsForm 曾缺 <Form>
 *  包裹，getFieldsValue 恒空、保存发空 body，所有配置静默丢失） */
test('设置保存：HTTPS 跳转开关开 → 保存 → 刷新仍为开', async ({ page }) => {
  test.setTimeout(150_000); // 可能等待一个 30s TOTP 窗口滚过（重放保护）
  test.skip(!adminTotpSecret, '依赖链路①产出的 TOTP 密钥');
  await page.goto('/login');
  await page.getByPlaceholder('用户名').fill('admin');
  await page.getByPlaceholder('密码').fill(ADMIN_NEW_PASSWORD);
  await page.getByRole('button', { name: /^登\s*录$/ }).click();
  // 服务端只接受 [C-1, C+1] 窗口的码，且链路③已消费 W=C+1：
  // 等到窗口滚过 W，再取「当前窗口+1」（=W+2 起），既新鲜又落在容忍窗内
  const boundaryMs = (lastUsedTotpWindow + 1) * 30_000 - Date.now() + 800;
  if (boundaryMs > 0) await page.waitForTimeout(boundaryMs);
  const freshWindow = Math.floor(Date.now() / 1000 / 30) + 1;
  const code = await generate({ secret: adminTotpSecret, epoch: freshWindow * 30 });
  await page.getByPlaceholder('6 位验证码或恢复码 xxxx-xxxx').fill(code);
  await page.getByRole('button', { name: /^验\s*证$/ }).click();
  await page.waitForURL(`${PORTAL}/account`);

  await page.getByRole('button', { name: '用户菜单' }).click();
  await page.getByRole('menuitem', { name: '管理后台' }).click();
  await expect(page.getByRole('button', { name: '总览' })).toBeVisible();
  await expect(page.getByText('注册用户总数')).toBeVisible();
  await expect(page.getByText('创建应用总数')).toBeVisible();
  await expect(page.getByText('近 30 天 Token 消耗')).toBeVisible();
  await expect(page.getByText('订阅计划分布')).toBeVisible();
  await expect(page.getByText('首次配置')).toHaveCount(0);
  await page.locator('.aap-user-sidebar__profile').click();
  await expect(page.getByRole('menuitem', { name: '个人中心' })).toBeVisible();
  await page.getByRole('menuitem', { name: '个人中心' }).click();
  await page.waitForURL(`${PORTAL}/account`);
  await expect(page.getByRole('heading', { name: '个人中心' })).toBeVisible();
  await page.goto('/admin?tab=overview');
  await page.getByRole('button', { name: '应用管理' }).click();
  await page.getByRole('button', { name: '接入 HTML 页' }).click();
  await page.locator('.aap-admin-page .ant-select').first().click();
  const visibilityOptions = page.locator('.ant-select-dropdown:visible .ant-select-item-option');
  await expect(visibilityOptions).toHaveCount(3);
  await expect(visibilityOptions).toContainText(['公开（免登录）', '站内（其他用户可克隆，不可直接访问）', '仅自己（私有）']);
  await page.keyboard.press('Escape');
  await page.locator('.ant-modal-close').click();
  await page.evaluate(() => {
    document.cookie = 'aap_user_page_theme=dark; Path=/';
  });
  await page.reload();
  await page.getByRole('button', { name: '站点设置' }).click();
  await expect(page.getByText('网站浏览器标题')).toBeVisible();
  const adminInput = page.locator('.aap-admin-page .ant-input').first();
  await expect(adminInput).toHaveCSS('background-color', 'rgb(20, 23, 28)');
  await expect(adminInput).toHaveCSS('color', 'rgb(242, 244, 247)');
  await expect(page.locator('.aap-admin-page .ant-form-item-label > label').first()).toHaveCSS('color', 'rgb(230, 232, 236)');
  await page.getByRole('button', { name: '证书' }).click();
  await expect(page.getByText('当前证书')).toBeVisible();
  await expect(page.getByText('Cloudflare DNS-01', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('HTTP-01', { exact: false })).toHaveCount(0);
  const tlsCard = page.locator('.ant-card', { hasText: 'HTTPS 跳转' });
  const switcher = tlsCard.locator('.ant-switch').first();
  await expect(switcher).toBeVisible();

  // 开 → 保存
  if (!(await switcher.getAttribute('class'))?.includes('ant-switch-checked')) {
    await switcher.click();
  }
  await tlsCard.getByRole('button', { name: /保存/ }).click();
  await expect(page.getByText('已保存并即时生效')).toBeVisible();

  // 回归断言（修复前保存发空 body，DB 恒为 false）：直读 DB 验证已落库。
  // 不能用页面刷新验证——开关打开后 HTTP 会被 302 到 HTTPS（e2e 无证书，
  // 连接被拒，这本身就是正确行为），页面验证走第 4 步。
  const [httpsRedirect] = runDatabaseQuery("SELECT value FROM settings WHERE key = 'HTTPS_REDIRECT'");
  expect(httpsRedirect?.value).toBe('true');

  // 显示路径验证：直接把 DB 还原为关 → 刷新（HTTP 不再跳转）→ 开关显示为关
  // （回归点：Form 实例曾未挂 <Form>，加载路径显示与 DB 不符）
  runDatabaseQuery("UPDATE settings SET value = 'false' WHERE key = 'HTTPS_REDIRECT'");
  await page.reload();
  const switcher2 = page.locator('.ant-card', { hasText: 'HTTPS 跳转' }).locator('.ant-switch').first();
  await expect(switcher2).not.toHaveClass(/ant-switch-checked/);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ['apps', 'users', 'security', 'llm', 'ops']) {
    await page.goto(`/admin?tab=${tab}`);
    const tableContent = page.locator('.aap-admin-page .ant-table-content').first();
    await expect(tableContent).toBeVisible();
    const scroll = await tableContent.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));
    expect(scroll.overflowX).toBe('auto');
    expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth).toBeLessThanOrEqual(390);
  }
});

/** M1 验收主链路⑤：普通用户不强制绑 MFA——初始密码改密后直达门户（曾误跳绑定页），
 *  绑定页可「跳过绑定」，个人中心安全 Tab 提供 MFA 管理卡片 */
test('普通用户改密直达门户 + 绑定页跳过 + 个人中心 MFA 管理', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('用户名').fill(NORMAL_USERNAME);
  await page.getByPlaceholder('密码').fill(NORMAL_INIT_PASSWORD);
  await page.getByRole('button', { name: /^登\s*录$/ }).click();

  // 强制改密（初始密码首登）
  await page.waitForURL('**/initialize**');
  await page.locator('input[type="password"]').nth(0).fill(NORMAL_INIT_PASSWORD);
  await page.locator('input[type="password"]').nth(1).fill(NORMAL_NEW_PASSWORD);
  await page.locator('input[type="password"]').nth(2).fill(NORMAL_NEW_PASSWORD);
  await page.getByRole('button', { name: '保存并继续' }).click();

  // 回归点：普通用户 mustEnrollMfa=false → 改密后回门户，不再被带入 /mfa-setup
  await page.waitForURL(`${PORTAL}/account`);
  await expect(page).not.toHaveURL(/mfa-setup/);

  // 自愿绑定路径：绑定页对非强制用户出示「跳过绑定」，点击回门户
  await page.goto('/mfa-setup');
  const skip = page.getByRole('button', { name: '跳过绑定' });
  await expect(skip).toBeVisible();
  await skip.click();
  await page.waitForURL(`${PORTAL}/`);

  // 个人中心-安全：MFA 管理卡片（未绑状态展示 TOTP 未绑定 + 绑定入口 + Passkey 区）
  await page.goto('/account');
  await expect(page.locator('.aap-account-shell')).toHaveCSS('background-color', 'rgb(242, 244, 247)');
  await expect(page.locator('.aap-account-page')).toHaveCSS('border-radius', '0px');
  await expect(page.locator('.aap-account-heading h2')).toHaveCSS('color', 'rgb(16, 24, 40)');
  await expect(page.locator('.aap-account-page .ant-card').first()).toHaveCSS('border-radius', '0px');
  await expect(page.locator('.aap-account-page .ant-alert-warning')).toHaveCSS('background-color', 'rgb(248, 250, 252)');
  await expect(page.locator('.aap-account-page .ant-alert-warning')).toHaveCSS('border-radius', '0px');
  for (const section of ['profile', 'security', 'myapps', 'billing']) {
    await expect(page.locator(`#account-section-${section}`)).toBeVisible();
  }
  const referenceCardTitleSize = await page
    .locator('#account-section-myapps .ant-card-head-title')
    .first()
    .evaluate((element) => getComputedStyle(element).fontSize);
  const referenceCardBodyPadding = await page
    .locator('#account-section-myapps .ant-card-body')
    .first()
    .evaluate((element) => getComputedStyle(element).paddingLeft);
  for (const section of ['profile', 'security']) {
    await expect(page.locator(`#account-section-${section} .ant-card-head-title`).first()).toHaveCSS('font-size', referenceCardTitleSize);
    await expect(page.locator(`#account-section-${section} .ant-card-body`).first()).toHaveCSS('padding-left', referenceCardBodyPadding);
  }
  await page.getByRole('tab', { name: '账户安全' }).click();
  await expect(page.locator('#account-section-security')).toBeInViewport();
  await expect(page.locator('.aap-account-page .ant-table-thead > tr > th').first()).toHaveCSS('background-color', 'rgb(228, 231, 236)');
  await expect(page.locator('.aap-account-page .ant-table-tbody > tr > td').first()).toHaveCSS('background-color', 'rgb(242, 244, 247)');
  await expect(page.getByText('多因子认证（MFA）')).toBeVisible();
  await expect(page.getByText('TOTP 验证器', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '绑定 TOTP' })).toBeVisible();
  await expect(page.getByText(/Passkey（\d+）/)).toBeVisible();

  // 我的权益：名称与权益包卡片更新，充值和订单默认隐藏
  await page.getByRole('tab', { name: '我的权益' }).click();
  await expect(page.locator('#account-section-billing')).toBeInViewport();
  await expect(page.getByText('当前权益详情')).toBeVisible();
  await expect(page.getByText('可创建应用', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('可选择权益包', { exact: true })).toBeVisible();
  await expect(page.getByText('使用兑换码')).toBeVisible();
  await expect(page.getByText('额度充值', { exact: true })).toHaveCount(0);
  await expect(page.getByText('我的订单', { exact: true })).toHaveCount(0);

  await page.getByRole('tab', { name: '个人资料' }).click();
  await expect(page.locator('#account-section-profile')).toBeInViewport();
  const cancelAccountButtonFontSize = await page.getByRole('button', { name: '申请注销账号' }).evaluate((element) => getComputedStyle(element).fontSize);
  await page.getByRole('button', { name: '申请注销账号' }).click();
  const stepUpTitle = page.getByText('验证身份（敏感操作）');
  const deleteTitle = page.getByText('确认注销账号');
  await expect(stepUpTitle.or(deleteTitle)).toBeVisible();
  await expect(page.locator('.aap-account-modal .ant-modal-content')).toHaveCSS('background-color', 'rgb(248, 250, 252)');
  await expect(page.locator('.aap-account-modal .ant-modal-content')).toHaveCSS('border-radius', '0px');
  await page.locator('.aap-account-modal .ant-modal-close').click();

  let failedMineRequest = false;
  await page.route('**/api/apps/mine', async (route) => {
    if (!failedMineRequest) {
      failedMineRequest = true;
      await page.waitForTimeout(300);
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'TEST_FAILURE', message: '模拟应用列表加载失败' } }),
      });
      return;
    }
    await route.continue();
  });
  await page.getByRole('tab', { name: '应用管理' }).click();
  await expect(page.locator('#account-section-myapps')).toBeInViewport();
  await expect(page.locator('#account-section-myapps .ant-spin-spinning')).toBeVisible();
  await expect(page.getByText('应用列表加载失败')).toBeVisible();
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('应用列表加载失败')).toHaveCount(0);
  await page.unroute('**/api/apps/mine');
  await expect(page.getByRole('button', { name: '选择文件' })).toHaveCSS('font-size', cancelAccountButtonFontSize);
  await page.locator('#account-section-profile').scrollIntoViewIfNeeded();
  await page.mouse.move(900, 600);
  await page.mouse.wheel(0, 700);
  await expect(page.getByRole('tab', { name: '账户安全' })).toHaveAttribute('aria-selected', 'true');
  await page.mouse.wheel(0, 1200);
  await expect(page.locator('[role="tab"][aria-selected="true"]')).toContainText(/应用管理|我的权益/);

  await page.goto('/my-apps');
  await expect(page.getByRole('heading', { name: '我的应用' })).toBeVisible();
  await expect(page.getByText('还没有创建或上传应用。前往应用管理上传 .awpk 包，开始发布你的创作。')).toBeVisible();
  await page.getByRole('button', { name: '前往应用管理' }).click();
  await expect(page).toHaveURL(/\/account\?tab=myapps$/);
  await expect(page.getByRole('tab', { name: '应用管理' })).toBeVisible();
});
