import { Button, Checkbox, Modal } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useNavigate } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { setGuideModalDismissed } from '../state/session';

const GUIDE_MD = [
  '# AI超级面板 · 应用制作与发布操作指南',
  '',
  '适合人群：不会写代码的普通用户。你只需要会和 AI 聊天、会上传文件，就能做出自己的小应用并分享给别人用。',
  '',
  '## 一、先搞懂：这是怎么回事',
  '',
  '**AI超级面板（AI-SuperPanel）** 是一个应用托管平台。你让自己的 AI 助手（agent）写好一个小工具，打包成 **`.asp-app`** 文件，上传到平台后，别人点开链接就能用——不用装软件，不用开终端，微信里也能打开。',
  '',
  '整个过程只有四步：',
  '',
  '| 步骤 | 你做什么 | 谁来干活 |',
  '| --- | --- | --- |',
  '| ① 装技能 | 把「asp-app 开发技能」装到你的 agent 里（一次性） | 你 |',
  '| ② 做应用 | 用大白话告诉 agent 你想要什么 | agent 自动写代码、检查、打包 |',
  '| ③ 上传 | 把得到的 `.asp-app` 文件上传到 AI超级面板 | 你 |',
  '| ④ 发布 | 试用没问题后，设置谁能看到并分享 | 你（必要时管理员审核） |',
  '',
  '> **名词小抄**',
  '>',
  '> - **agent**：你日常用的 AI 助手，如 Claude。',
  '> - **技能（skill）**：给 agent 装的“专业说明书”，装了它，agent 就知道怎么做出能在 AI超级面板上运行的应用。',
  '> - **`.asp-app`**：应用安装包，本质是一个压缩文件，里面装着应用本体和一份“自我介绍”。',
  '',
  '## 二、开始前准备',
  '',
  '- [ ] 一个可以使用的 AI超级面板 账号（向管理员申请，或在登录页自行注册）',
  '- [ ] 一个支持安装技能、并能运行代码的 agent（下一节有具体说明）',
  '- [ ] 拿到技能安装文件 **`asp-app-develop.skill`**（从本页面下载）',
  '',
  '## 三、第一步：把技能安装到你的 agent',
  '',
  '这一步只需做一次。按你使用的 agent 选一种方式。',
  '',
  '### 方式 A：Claude 网页版 / App（最简单）',
  '',
  '1. 打开 Claude，进入 **设置**，找到 **技能（Skills）** 管理页（通常在 Capabilities 下，菜单名以你的版本为准）。',
  '2. 点击上传，选择 `asp-app-develop.skill` 文件。',
  '3. 把这个技能的开关**打开**。',
  '4. 同时确认已开启 **代码执行和文件创建** 功能——技能里的检查和打包脚本需要它才能运行。',
  '',
  '### 方式 B：Claude Code 或其他本地 agent',
  '',
  '把 `asp-app-develop.skill` 当作压缩包解压，得到的 `asp-app-develop` 文件夹放进技能目录：',
  '',
  '- 个人使用：`~/.claude/skills/asp-app-develop/`',
  '- 仅某个项目使用：`项目目录/.claude/skills/asp-app-develop/`',
  '',
  '### 方式 C：不支持“技能”的 agent',
  '',
  '把解压后文件夹里的 `SKILL.md` 内容发给 agent，并告诉它“以后按这份规范帮我开发应用”；需要时再把 `references` 里的文档一并发给它。效果不如方式 A、B 稳定，但同样能用。',
  '',
  '### 怎么确认装好了？',
  '',
  '直接对 agent 说：“**我想做一个能放到 AI超级面板的应用，你知道怎么做吗？**”如果它提到 `.asp-app`、能让你描述需求，就说明技能已经生效。',
  '',
  '## 四、第二步：让 agent 做出你的应用',
  '',
  '### 1. 先想清楚三件事',
  '',
  '把下面三点说给 agent 听，它就能开工：',
  '',
  '1. **做什么**：例如“显示全球各城市当前时间”。',
  '2. **要不要 AI**：比如“让 AI 帮我总结文章”，这类需要调用大模型。',
  '3. **要不要联网查资料**：例如“查询天气”，需要访问外部网站或第三方服务。',
  '',
  '### 2. 平台支持的三种应用',
  '',
  'agent 会根据你的需求自动选择，你不用自己判断：',
  '',
  '| 类型 | 适合做什么 | 举例 |',
  '| --- | --- | --- |',
  '| **HTML 工具** | 纯页面小工具，不需要后台 | 时钟、计算器、文本转换 |',
  '| **按调用运行的应用** | 填表提交 → AI 或程序处理 → 返回结果 | 文章总结、翻译、数据整理 |',
  '| **常驻服务应用** | 自带完整网页和多个功能页面 | 校对系统、IP 查询工具 |',
  '',
  '> 没有特殊需求时，agent 会选最轻量的方式，这样审核更快、占用资源更少。',
  '',
  '### 3. 可以直接照着说的例子',
  '',
  '**例 1：纯页面工具**',
  '',
  '> 帮我做一个全球时钟页面，显示世界主要城市的当前时间，并打包成 asp-app。',
  '',
  '**例 2：用到 AI 的工具**',
  '',
  '> 做一个工具：我粘贴一篇文章，AI 帮我总结成三句话。要能放到 AI超级面板，打包成 asp-app。',
  '',
  '**例 3：改造现成项目**',
  '',
  '> 这是我已有的网页项目（上传文件），帮我改造成能放到 AI超级面板的 asp-app。',
  '',
  '### 4. agent 会交给你什么',
  '',
  '做完后你会收到两样东西：',
  '',
  '- **一个 `.asp-app` 文件**，文件名形如 `world-clock-1.0.0.asp-app`，把它**下载到你的电脑**。',
  '- **一份交付说明**，请重点看这几项：',
  '  - **需要你配置的变量**：如果应用要用第三方服务的密钥（如某个 API Key），说明里会写明变量名和获取方式，**上传后你需要在平台里填写**。',
  '  - **入参说明**：按调用运行的应用会列出需要用户填写哪些输入项。',
  '  - **已知限制**：agent 无法在本地验证的地方会如实告诉你。',
  '',
  '> **安全提醒**：任何时候都不要把密钥直接发给应用或写进页面里。正确做法是上传后在平台的「环境变量」里填写，平台会加密保存，填完后只写不读。',
  '',
  '### 5. 想改怎么办？',
  '',
  '直接继续聊：“把背景改成深色”“再加一个搜索框”。agent 改完会重新打包，得到新的 `.asp-app` 文件（建议让它顺便升一下版本号，如 1.0.1）。',
  '',
  '## 五、第三步：上传到 AI超级面板',
  '',
  '### 管理员上传（管理后台）',
  '',
  '1. 登录 AI超级面板，进入 **管理后台**。',
  '2. 点击顶部的 **应用管理** 标签。',
  '3. 在「应用列表」右上角，点击 **上传 .asp-app** 按钮，选择刚才下载的文件。',
  '4. 平台会自动检查并读取应用信息。成功后，列表里会出现新的一行，显示：ID、名称、形态（如 HTML）、可见性、健康状态和操作按钮（编辑、删除）。',
  '',
  '> 以“全球时钟”为例：上传后列表里显示 ID `world-clock`、形态 `HTML`、可见性 `公开`。健康一栏显示“未知”时不必紧张，以首页卡片能否正常打开为准。',
  '',
  '### 普通用户上传',
  '',
  '普通用户可在 **用户中心 → 我的应用** 中上传（入口名称以你们平台的实际界面为准）。上传后应用默认是 **私有**，只有你自己看得到、用得了。',
  '',
  '### 上传失败怎么办？',
  '',
  '平台会把原因原样提示出来，常见原因有：包名重复、文件格式不对、依赖库无法安装等。把提示**原文复制给 agent**，它会帮你修好并重新打包。',
  '',
  '## 六、第四步：试用、发布、分享',
  '',
  '### 1. 先试用（必做）',
  '',
  '回到 AI超级面板首页，应用会以卡片形式出现在「用户提交」区域（示例：卡片上有应用名称、“公开”标签和 **打开 →** 链接）。点开使用，确认功能正常。',
  '',
  '如果是需要密钥的应用，先到该应用的 **环境变量** 里把交付说明列出的变量填好。需要用户填写输入项的应用，还要按交付说明里的入参说明，在平台上配置好对应的输入项。',
  '',
  '### 2. 发布流程',
  '',
  '```',
  '上传 → 默认私有（只有你能用）→ 试运行 → 提交审核 → 管理员通过 → 公开',
  '```',
  '',
  '- 管理员上传的应用，可以直接设置可见范围。',
  '- 普通用户的应用，需要 **提交审核**；管理员看过代码、试运行没问题后通过。**被驳回时会附带理由**，把理由发给 agent，修改后重新打包上传再提审即可。',
  '- 以后更新版本，同样需要重新审核。',
  '',
  '### 3. 可见范围怎么选',
  '',
  '| 可见范围 | 谁能看到 | 适合场景 |',
  '| --- | --- | --- |',
  '| 公开 | 所有人 | 想让大家都用 |',
  '| 需登录 | 登录用户 | 不想对外暴露 |',
  '| 指定分组 / 账号 | 你选择的人 | 团队内部使用 |',
  '| 仅自己 | 只有你 | 自己试用、调试 |',
  '',
  '### 4. 分享给别人',
  '',
  '公开或对应范围发布后，把应用的访问链接发给对方即可。对方点开就能用，不需要安装任何东西。',
  '',
  '## 七、常见问题',
  '',
  '| 问题 | 解答 |',
  '| --- | --- |',
  '| 我完全不会写代码，能做吗？ | 能。你只负责说需求和上传文件，写代码、检查、打包都由 agent 完成。 |',
  '| agent 说“无法运行脚本”怎么办？ | 请确认 agent 已开启代码执行功能；仍不行，就让它直接交付代码并说明未做自动检查，上传后再用平台的试运行来验证。 |',
  '| 应用需要联网查资料，会被拦吗？ | 平台只放行事先声明的网站。agent 会在交付说明里列出需要访问的域名，管理员审核时按这个清单来看。 |',
  '| 应用里怎么用 AI？ | 不用自己申请模型密钥。应用通过平台调用大模型，使用量按**使用者**的额度计算。 |',
  '| 页面里的数据能保存吗？ | 页面本身不能使用浏览器存储。需要保存数据的应用会由 agent 改用平台提供的数据库，你不用操心。 |',
  '| 上传后打不开？ | 先看首页卡片的状态；再把现象和提示原文发给 agent 排查。 |',
  '| 能同时有多个版本吗？ | 更新时重新打包升级版本号再上传即可，新版本会重新走审核。 |',
  '',
  '## 八、一页速查',
  '',
  '1. 装技能：设置 → 技能 → 上传 `asp-app-develop.skill` → 开启，并打开代码执行。',
  '2. 说需求：告诉 agent 做什么、要不要 AI、要不要联网，并说明“打包成 asp-app”。',
  '3. 下载包：保存 agent 给你的 `.asp-app` 文件，认真看交付说明。',
  '4. 上传包：管理后台 → 应用管理 → **上传 .asp-app**（普通用户：用户中心 → 我的应用）。',
  '5. 配置并试用：按说明填环境变量 → 打开卡片试用。',
  '6. 发布分享：提交审核 → 通过后设置可见范围 → 把链接发给对方。',
].join('\n');

const GUIDE_MD_TEXT = GUIDE_MD;

const QUICK_START_ITEMS = [
  { label: '一、先搞懂', target: 'guide-overview' },
  { label: '二、准备工作', target: 'guide-preparation' },
  { label: '三、安装 skill', target: 'guide-install-skill' },
  { label: '四、生成应用', target: 'guide-build-app' },
];

function slugifyHeading(text: string): string {
  return text
    .replace(/^[\s\uFEFF]+|[\s\uFEFF]+$/g, '')
    .replace(/[\u3000\s]+/g, '-')
    .replace(/[^\u4e00-\u9fffA-Za-z0-9\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function resolveHeadingId(text: string): string {
  const normalized = text.trim();
  if (normalized.includes('先搞懂')) return 'guide-overview';
  if (normalized.includes('开始前准备')) return 'guide-preparation';
  if (normalized.includes('把技能安装到你的 agent')) return 'guide-install-skill';
  if (normalized.includes('第二步：让 agent 做出你的应用')) return 'guide-build-app';
  if (normalized.includes('第三步：上传到 AI超级面板')) return 'guide-upload';
  if (normalized.includes('第四步：试用、发布、分享')) return 'guide-publish';
  if (normalized.includes('常见问题')) return 'guide-faq';
  if (normalized.includes('一页速查')) return 'guide-quick-check';
  return slugifyHeading(normalized);
}

function scrollToGuideSection(targetId: string) {
  const element = document.getElementById(targetId);
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function downloadSkill(): void {
  const anchor = document.createElement('a');
  anchor.href = '/api/dev/guide/download';
  anchor.download = 'asp-app-develop.skill';
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function renderGuideBody() {
  return (
    <div style={{ color: 'var(--aap-text)' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 style={{ margin: '0 0 16px', fontSize: 28, fontWeight: 800, lineHeight: 1.3, color: 'var(--aap-text)' }}>{children}</h1>
          ),
          h2: ({ children }) => {
            const text = Array.isArray(children) ? children.join('') : String(children ?? '');
            const id = resolveHeadingId(text);
            return (
              <h2 id={id} style={{ margin: '26px 0 12px', fontSize: 20, fontWeight: 700, lineHeight: 1.4, color: 'var(--aap-text)' }}>
                {children}
              </h2>
            );
          },
          h3: ({ children }) => {
            const text = Array.isArray(children) ? children.join('') : String(children ?? '');
            const id = resolveHeadingId(text);
            return (
              <h3 id={id} style={{ margin: '18px 0 10px', fontSize: 16, fontWeight: 700, lineHeight: 1.4, color: 'var(--aap-text)' }}>
                {children}
              </h3>
            );
          },
          p: ({ children }) => (
            <p style={{ margin: '0 0 14px', lineHeight: 1.8, color: 'var(--aap-text)' }}>{children}</p>
          ),
          ul: ({ children }) => (
            <ul style={{ margin: '0 0 14px 18px', padding: 0, lineHeight: 1.9, color: 'var(--aap-text)' }}>{children}</ul>
          ),
          ol: ({ children }) => (
            <ol style={{ margin: '0 0 14px 18px', padding: 0, lineHeight: 1.9, color: 'var(--aap-text)' }}>{children}</ol>
          ),
          li: ({ children }) => <li style={{ marginBottom: 6 }}>{children}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--aap-primary)', textDecoration: 'none', fontWeight: 600 }}>
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote
              style={{
                margin: '12px 0 16px',
                padding: '12px 14px',
                borderLeft: '4px solid var(--aap-primary)',
                background: 'var(--aap-bg-layout)',
                borderRadius: 8,
                color: 'var(--aap-text)',
              }}
            >
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div style={{ overflowX: 'auto', margin: '12px 0 18px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid var(--aap-border)', fontSize: 13, color: 'var(--aap-text)' }}>{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th style={{ textAlign: 'left', padding: '10px 12px', border: '1px solid var(--aap-border)', background: 'var(--aap-bg-layout)', color: 'var(--aap-text)' }}>{children}</th>
          ),
          td: ({ children }) => (
            <td style={{ padding: '10px 12px', border: '1px solid var(--aap-border)', verticalAlign: 'top', color: 'var(--aap-text)' }}>{children}</td>
          ),
          code: ({ children, className, ...props }) => {
            const isInline = !className;
            return isInline ? (
              <code {...props} style={{ padding: '2px 6px', borderRadius: 6, background: 'var(--aap-bg-layout)', fontSize: '0.92em', color: 'var(--aap-text)' }}>
                {children}
              </code>
            ) : (
              <pre style={{ margin: '12px 0 18px', overflowX: 'auto', padding: 12, borderRadius: 8, background: '#111827', color: '#e5e7eb' }}>
                <code className={className} {...props}>{children}</code>
              </pre>
            );
          },
          hr: () => <hr style={{ border: 'none', borderTop: '1px solid var(--aap-border)', margin: '18px 0' }} />,
        }}
      >
        {GUIDE_MD_TEXT}
      </ReactMarkdown>
    </div>
  );
}

interface GuideModalProps {
  open: boolean;
  onClose: () => void;
  showDontAskAgain?: boolean;
}

export function GuideModal({ open, onClose, showDontAskAgain = false }: GuideModalProps) {
  const [doNotAskAgain, setDoNotAskAgain] = useState(false);
  const defaultSection = QUICK_START_ITEMS[0]?.target ?? 'guide-overview';
  const [activeSection, setActiveSection] = useState<string>(defaultSection);

  useEffect(() => {
    if (!open) {
      setDoNotAskAgain(false);
      setActiveSection(defaultSection);
    }
  }, [open, defaultSection]);

  useEffect(() => {
    if (!open) return;

    const headings = QUICK_START_ITEMS
      .map((item) => document.getElementById(item.target))
      .filter(Boolean) as HTMLElement[];

    if (!headings.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

        if (visible?.target?.id) {
          setActiveSection(visible.target.id);
        }
      },
      { root: null, threshold: [0.2, 0.5, 0.8], rootMargin: '0px 0px -20% 0px' },
    );

    headings.forEach((heading) => observer.observe(heading));

    return () => observer.disconnect();
  }, [open]);

  const handleClose = () => {
    if (showDontAskAgain && doNotAskAgain) {
      setGuideModalDismissed(true);
    }
    onClose();
  };

  const handleQuickStartClick = (targetId: string) => {
    setActiveSection(targetId);
    scrollToGuideSection(targetId);
  };

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      onOk={handleClose}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 20, fontWeight: 700 }}>操作指南</span>
          <span style={{ fontSize: 12, color: 'var(--aap-text-secondary)', background: 'rgba(22,119,255,0.08)', padding: '4px 8px', borderRadius: 999 }}>AI超级面板</span>
        </div>
      }
      width={1100}
      destroyOnClose
      centered
      styles={{
        body: { padding: 0, background: 'var(--aap-bg-layout)' },
        header: { borderBottom: '1px solid var(--aap-border)', padding: '16px 20px 12px', background: 'var(--aap-bg-container)' },
        footer: { borderTop: '1px solid var(--aap-border)', padding: '12px 20px 16px', background: 'var(--aap-bg-container)' },
      }}
      footer={
        showDontAskAgain
          ? [
              <Checkbox key="check" checked={doNotAskAgain} onChange={(e) => setDoNotAskAgain(e.target.checked)}>
                下次不再提示
              </Checkbox>,
              <Button key="download" type="primary" icon={<DownloadOutlined />} onClick={downloadSkill}>
                下载skill
              </Button>,
              <Button key="close" onClick={handleClose}>
                关闭
              </Button>,
            ]
          : [
              <Button key="download" type="primary" icon={<DownloadOutlined />} onClick={downloadSkill}>
                下载skill
              </Button>,
              <Button key="close" onClick={handleClose}>
                关闭
              </Button>,
            ]
      }
    >
      <div style={{ padding: 24 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.7fr) minmax(240px, 0.7fr)', gap: 20 }}>
          <div
            style={{
              background: 'var(--aap-bg-container)',
              border: '1px solid var(--aap-border)',
              borderRadius: 12,
              padding: '18px 20px',
              boxShadow: '0 2px 12px rgba(15, 23, 42, 0.03)',
            }}
          >
            {renderGuideBody()}
          </div>

          <aside
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              background: 'var(--aap-bg-container)',
              border: '1px solid var(--aap-border)',
              borderRadius: 12,
              padding: '18px 16px',
              boxShadow: '0 2px 12px rgba(15, 23, 42, 0.03)',
              height: 'fit-content',
              position: 'sticky',
              top: 20,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, color: 'var(--aap-text-secondary)', textTransform: 'uppercase' }}>
              Quick start
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--aap-text)' }}>
              4 步速览
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {QUICK_START_ITEMS.map((step, index) => {
                const isActive = activeSection === step.target;
                return (
                  <button
                    type="button"
                    key={step.label}
                    onClick={() => handleQuickStartClick(step.target)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      borderRadius: 10,
                      background: isActive ? 'rgba(22, 119, 255, 0.08)' : 'var(--aap-bg-layout)',
                      border: isActive ? '1px solid rgba(22, 119, 255, 0.4)' : '1px solid var(--aap-border)',
                      color: 'var(--aap-text)',
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      boxShadow: isActive ? '0 0 0 1px rgba(22, 119, 255, 0.12)' : 'none',
                    }}
                    onMouseEnter={(event) => {
                      if (!isActive) {
                        event.currentTarget.style.background = 'var(--aap-bg-layout)';
                        event.currentTarget.style.borderColor = 'var(--aap-primary)';
                      }
                    }}
                    onMouseLeave={(event) => {
                      if (!isActive) {
                        event.currentTarget.style.background = 'var(--aap-bg-layout)';
                        event.currentTarget.style.borderColor = 'var(--aap-border)';
                      }
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-flex',
                        width: 24,
                        height: 24,
                        borderRadius: 8,
                        background: isActive ? 'var(--aap-primary)' : 'var(--aap-bg-container)',
                        color: isActive ? '#fff' : 'var(--aap-text)',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        fontWeight: 700,
                        border: isActive ? 'none' : '1px solid var(--aap-border)',
                      }}
                    >
                      {index + 1}
                    </span>
                    {step.label}
                  </button>
                );
              })}
            </div>

            <Button type="primary" size="large" icon={<DownloadOutlined />} onClick={downloadSkill} style={{ marginTop: 6 }}>
              下载 skill
            </Button>

            <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--aap-bg-layout)', color: 'var(--aap-text-secondary)', fontSize: 12 }}>
              适用人群：普通用户 / 不写代码也能开始
            </div>
          </aside>
        </div>
      </div>
    </Modal>
  );
}

export function GuidePage() {
  const navigate = useNavigate();

  return <GuideModal open onClose={() => navigate('/', { replace: true })} showDontAskAgain={false} />;
}
