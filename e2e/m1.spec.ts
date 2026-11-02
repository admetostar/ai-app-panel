import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { generate } from 'otplib';
import { INIT_ADMIN_PASSWORD, ADMIN_NEW_PASSWORD, NORMAL_USERNAME, NORMAL_INIT_PASSWORD, PORTAL, latestCodeFromLog } from './global-setup';

const NORMAL_NEW_PASSWORD = 'e2e-normal-password-123';

/** 测试间共享（workers=1 串行，同一进程模块状态保留） */
let adminTotpSecret = '';
/** 链路③已消费的 TOTP 窗口计数（服务端重放保护以此为下界） */
let lastUsedTotpWindow = 0;

test('首页导航定位与登录注册分栏页面', async ({ page }) => {
  await page.goto('/');
  const plansResponse = await page.request.get(`${PORTAL}/api/portal/plans`);
  expect(plansResponse.ok()).toBe(true);
  expect((await plansResponse.json()).plans).toBeInstanceOf(Array);
  await expect(page.locator('.aap-home-title')).toBeVisible();
  await expect(page.locator('.aap-home-title')).toContainText('您好，欢迎来到 AI超级面板');
  await expect(page.locator('.aap-home-description')).toContainText('AI超级面板（AI-SuperPanel）');
  await expect(page.locator('.aap-home-description')).toContainText('上传到AI超级面板后');
  await expect(page.locator('.aap-home-shell .aap-header')).toHaveCSS('backdrop-filter', 'none');
  await expect(page.locator('.aap-home-kicker')).toHaveText('AI超级面板');
  await expect(page.getByPlaceholder('搜索应用名称或介绍')).toBeVisible();
  await expect(page.locator('.aap-home-search .ant-input')).toHaveCSS('color', 'rgb(16, 24, 40)');
  expect(
    await page.locator('.aap-home-search .ant-input').evaluate((input) => getComputedStyle(input, '::placeholder').color),
  ).toBe('rgb(71, 84, 103)');
  const homeNav = page.locator('.aap-home-nav');
  await expect(homeNav.getByRole('link', { name: '发现应用' })).toBeVisible();
  const homeHeader = page.locator('.aap-home-page-shell .aap-header');
  const loginButton = homeNav.getByRole('button', { name: /登录/ });
  await expect(homeHeader).toHaveCSS('position', 'fixed');
  await expect(homeHeader).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(homeNav.getByRole('link', { name: '发现应用' })).toHaveCSS('color', 'rgba(242, 244, 247, 0.9)');
  await expect(loginButton).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(loginButton).toHaveCSS('color', 'rgb(16, 24, 40)');
  expect(
    await homeNav.evaluate((nav) => Number.parseFloat(getComputedStyle(nav).columnGap)),
  ).toBeGreaterThanOrEqual(20);

  const rightsLink = homeNav.getByRole('link', { name: '权益' });
  await rightsLink.click();
  await expect(page.locator('#home-rights')).toBeInViewport();
  await expect(rightsLink).toHaveCSS('color', 'rgb(52, 64, 84)');
  await expect(homeHeader).toHaveCSS('top', '0px');
  await expect(homeHeader).toHaveCSS('background-color', 'rgba(248, 250, 252, 0.78)');
  await expect(homeHeader).toHaveCSS('backdrop-filter', 'blur(18px)');
  await expect(loginButton).toHaveCSS('background-color', 'rgb(16, 24, 40)');
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
  await expect(page).toHaveURL(/\/guide$/);
  await expect(page.locator('.aap-guide-progress li')).toHaveCount(5);
  for (let step = 2; step <= 5; step += 1) {
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.locator('.aap-guide-step__topline')).toContainText(`第 ${step} 步`);
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
  await page.locator('.aap-home-nav').getByRole('link', { name: /登录/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('.aap-auth-art')).toHaveCSS('background-image', /login/);
  await expect(page.getByRole('button', { name: /^登\s*录$/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Terms of Service' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Acceptable Use Policy' })).toBeVisible();
  await expect(page.locator('footer.aap-footer')).toBeVisible();
  await page.goto('/terms');
  await expect(page.locator('.aap-legal-shell')).toBeVisible();
  await expect(page.locator('.aap-legal-page .ant-card')).toHaveCount(0);
  await expect(page.locator('.aap-legal-shell .aap-header')).toHaveCSS('background-color', 'rgba(8, 24, 63, 0.48)');
  await expect(page.locator('.aap-legal-shell .aap-header')).toHaveCSS('backdrop-filter', 'blur(14px)');
  await page.goto('/guide');
  await expect(page.locator('.aap-header')).toHaveCSS('backdrop-filter', 'blur(14px)');
  await page.goto('/login');
  await expect(page.locator('.aap-auth-art')).toBeHidden();
  await page.getByRole('link', { name: '注册账号' }).click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.locator('.aap-auth-content')).toBeVisible();
  await expect(page.locator('.aap-auth-art')).toBeHidden();
});

test('首页品牌文案跟随站点名称设置', async ({ page }) => {
  await page.route('**/api/portal/bootstrap', async (route) => {
    const response = await route.fetch();
    const bootstrap = await response.json() as { branding: { siteName: string } };
    bootstrap.branding.siteName = '运营站点名称';
    await route.fulfill({ response, json: bootstrap });
  });

  await page.goto('/');
  await expect(page.locator('.aap-home-kicker')).toHaveText('运营站点名称');
  await expect(page.locator('.aap-home-title')).toContainText('您好，欢迎来到 运营站点名称');
  await expect(page.locator('.aap-home-description')).toContainText('运营站点名称（AI-SuperPanel）');
  await expect(page.locator('.aap-home-description')).toContainText('上传到运营站点名称后');
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
  await expect(page.getByRole('menuitem', { name: '退出登录' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '应用管理' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '账户安全' })).toHaveCount(0);
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
  await page.locator('#password').fill('e2e-password-123');
  await page.locator('#password2').fill('e2e-password-123');
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
    '一、了解平台并做好准备',
    '二、安装开发技能',
    '三、让 agent 做出你的应用',
    '四、上传到 AI超级面板',
    '五、先试用然后发布',
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
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(guideContent.getByRole('heading', { name: '告诉agent你要一个什么应用' })).toBeVisible();
  await expect(guideContent.getByText('帮我做一个全球时钟，显示主要城市的当前时间，并打包成 awpk-app。')).toBeVisible();
  await expect(guideContent).not.toContainText('环境变量');
  await expect(guideContent).not.toContainText('入参');

  await page.getByRole('button', { name: '下一步' }).click();
  await expect(guideContent).toContainText('环境变量');
  await expect(guideContent).toContainText('填写所需入参');
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
  await page.getByRole('tab', { name: '证书' }).click();
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
  const dbPath = path.join(__dirname, '.run', 'data', 'app.db');
  const readSetting = (): string =>
    execFileSync(
      'node',
      ["-e", "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});console.log(db.prepare(\"SELECT value FROM settings WHERE key='HTTPS_REDIRECT'\").get().value)", dbPath],
      { cwd: path.join(__dirname, '../apps/server') },
    ).toString().trim();
  expect(readSetting()).toBe('true');

  // 显示路径验证：直接把 DB 还原为关 → 刷新（HTTP 不再跳转）→ 开关显示为关
  // （回归点：Form 实例曾未挂 <Form>，加载路径显示与 DB 不符）
  execFileSync(
    'node',
    ["-e", "const D=require('better-sqlite3');const db=new D(process.argv[1]);db.prepare(\"UPDATE settings SET value='false' WHERE key='HTTPS_REDIRECT'\").run()", dbPath],
    { cwd: path.join(__dirname, '../apps/server') },
  );
  await page.reload();
  await page.getByRole('tab', { name: '证书' }).click();
  const switcher2 = page.locator('.ant-card', { hasText: 'HTTPS 跳转' }).locator('.ant-switch').first();
  await expect(switcher2).not.toHaveClass(/ant-switch-checked/);
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
  await expect(page.getByText('可上传应用', { exact: true }).first()).toBeVisible();
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
