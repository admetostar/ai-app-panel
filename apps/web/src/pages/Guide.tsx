import { Button, Progress, Typography } from 'antd';
import { ArrowRightOutlined, DownloadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useNavigate } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { useSession } from '../state/session';
import { GUIDE_FAQ_ITEMS } from '../lib/guideFaq';

const GUIDE_MD = [
  '# AI超级面板 · 应用制作与发布操作指南',
  '',
  '适合人群：不会写代码的普通用户。你只需要会和 AI 聊天、会上传文件，就能做出自己的小应用并分享给别人用。',
  '',
  '## 一、先搞懂并做好准备',
  '',
  '**AI超级面板（AI-SuperPanel）** 是一个应用托管平台。你让自己的 AI 助手（agent）写好一个小工具，打包成 **`.asp-app`** 文件，上传到平台后，别人点开链接就能用——不用安装软件，不用开终端，有互联网就能打开。',
  '',
  '**整个过程只有四步：**',
  '',
  '| 步骤 | 你做什么 | 谁来干活 |',
  '| --- | --- | --- |',
  '| ① 装技能 | 把「asp-app 开发技能」装到你的 agent 里（一次性） | 你 |',
  '| ② 做应用 | 用大白话告诉 agent 你想要什么 | agent 自动写代码、检查、打包 |',
  '| ③ 上传 | 把得到的 `.asp-app` 文件上传到 AI超级面板 | 你 |',
  '| ④ 发布 | 试用没问题后，设置为公开并分享 | 你 |',
  '',
  '> **名词小抄**',
  '>',
  '> - **agent**：你日常用的 AI 助手，如 Claude。',
  '> - **技能（skill）**：给 agent 装的“专业说明书”，装了它，agent 就知道怎么做出能在 AI超级面板上运行的应用。',
  '> - **`.asp-app`**：应用安装包，本质是一个压缩文件，里面装着应用本体和一份“自我介绍”。',
  '',
  '**你需要做好这些准备：**',
  '',
  '- 一个可以使用的 AI超级面板账号（向管理员申请，或在登录页自行注册）',
  '- 一个支持安装技能、并能运行代码的 agent（下一节有具体说明）',
  '- 拿到技能安装文件 **`asp-app-develop.skill`**（从本页面下载）',
  '',
  '## 二、第一步：把技能安装到你的 agent',
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
  '## 三、第二步：让 agent 做出你的应用',
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
  '## 四、第三步：上传到 AI超级面板',
  '',
  '### 上传应用',
  '',
  '1. 进入 **用户中心 → 我的应用**，点击 **上传 .asp-app**，选择 agent 生成的应用包。',
  '2. 上传后，平台会检查文件并读取应用信息；检查通过后，应用会显示在「我的应用」列表中。',
  '',
  '> 上传后可在「我的应用」中查看应用状态，并按页面提示完成设置。',
  '',
  '### 上传失败怎么办？',
  '',
  '平台会把原因原样提示出来，常见原因有：包名重复、文件格式不对、依赖库无法安装等。把提示**原文复制给 agent**，它会帮你修好并重新打包。',
  '',
  '## 五、第四步：试用、发布、分享',
  '',
  '### 1. 选择可见范围并试运行',
  '',
  '在 **用户中心 → 我的应用** 中打开刚上传的应用，选择可见范围。平台会自动安装应用；安装完成后进行试运行，确认页面和功能正常。',
  '',
  '如果应用需要密钥，先在应用设置的 **环境变量** 中填写交付说明列出的变量；需要用户填写内容的应用，则按入参说明配置对应输入项。',
  '',
  '### 2. 发布并分享',
  '',
  '选择待发布的应用，将可见范围设置为**公开**，确认面板首页展示的该应用卡片标记为公开后，即可通过卡片链接分享该应用。',
  '',
  '> **提示**：每个账号可发布的应用数量受订阅计划限制。详情请进入 **用户中心 → 我的权益** 查看。',
  '',
  '### 可见范围怎么选',
  '',
  '| 可见范围 | 谁能看到 | 适合场景 |',
  '| --- | --- | --- |',
  '| 公开 | 所有人 | 想让大家都用并分享链接 |',
  '| 需登录 | 登录用户 | 不想对外暴露 |',
  '| 指定分组 / 账号 | 你选择的人 | 团队内部使用 |',
  '| 仅自己 | 只有你 | 自己试用、调试 |',
  '',
  '## 六、常见问题',
  '',
  '| 问题 | 解答 |',
  '| --- | --- |',
  ...GUIDE_FAQ_ITEMS.map(({ question, answer }) => `| ${question} | ${answer} |`),
  '',
  '## 七、一页速查',
  '',
  '1. 装技能：设置 → 技能 → 上传 `asp-app-develop.skill` → 开启，并打开代码执行。',
  '2. 说需求：告诉 agent 做什么、要不要 AI、要不要联网，并说明“打包成 asp-app”。',
  '3. 下载包：保存 agent 给你的 `.asp-app` 文件，认真看交付说明。',
  '4. 上传并设置：用户中心 → 我的应用 → 上传 `.asp-app` → 选择可见范围。',
  '5. 安装并试运行：等待平台自动安装 → 按说明配置环境变量和入参 → 试运行。',
  '6. 公开分享：确认运行正常后设为公开 → 把访问链接发给对方。',
].join('\n');

const GUIDE_MD_TEXT = GUIDE_MD;

const GUIDE_SECTION_PARTS = GUIDE_MD_TEXT.split(/(?=^## )/m)
  .map((content) => content.trim())
  .filter(Boolean);
const GUIDE_STEPS = [
  GUIDE_SECTION_PARTS.slice(0, 2).join('\n\n'),
  ...GUIDE_SECTION_PARTS.slice(2, 6),
]
  .map((content, index) => {
    const heading = content.match(/^##\s+(.+)$/m)?.[1];
    return {
      title: heading ?? '认识 AI 超级面板',
      content,
      index,
    };
  });

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

function GuideMarkdown({ content }: { content: string }) {
  return (
    <div className="aap-guide-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1>{children}</h1>,
          h2: ({ children }) => <h2>{children}</h2>,
          h3: ({ children }) => <h3>{children}</h3>,
          p: ({ children }) => <p>{children}</p>,
          ul: ({ children }) => <ul>{children}</ul>,
          ol: ({ children }) => <ol>{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
          blockquote: ({ children }) => <blockquote>{children}</blockquote>,
          table: ({ children }) => <div className="aap-guide-markdown__table"><table>{children}</table></div>,
          th: ({ children }) => <th>{children}</th>,
          td: ({ children }) => <td>{children}</td>,
          code: ({ children, className, ...props }) => className
            ? <pre><code className={className} {...props}>{children}</code></pre>
            : <code {...props}>{children}</code>,
          hr: () => <hr />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function GuidePage() {
  const navigate = useNavigate();
  const { me, loading } = useSession();
  const [activeStep, setActiveStep] = useState(0);
  const currentStep = GUIDE_STEPS[activeStep];
  const isLastStep = activeStep === GUIDE_STEPS.length - 1;

  function finishGuide(): void {
    navigate(me ? '/my-apps' : '/login', { replace: true });
  }

  function goNext(): void {
    if (isLastStep) {
      finishGuide();
      return;
    }
    setActiveStep((step) => step + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (loading || !currentStep) {
    return <div className="aap-guide-page"><div className="aap-guide-loading">正在准备你的操作导航…</div></div>;
  }

  return (
    <div className="aap-guide-page">
      <section className="aap-guide-heading">
        <span className="aap-guide-eyebrow">YOUR FIRST APP, STEP BY STEP</span>
        <Typography.Title level={1}>从一个想法，到一个可分享的应用</Typography.Title>
        <Typography.Paragraph>
          不需要编程经验。跟着这份操作导航，一步步完成准备、制作、上传和发布。
        </Typography.Paragraph>
        <div className="aap-guide-heading__meta">
          <span>{GUIDE_STEPS.length} 个轻松步骤</span>
          <span>·</span>
          <span>随时可以跳过</span>
          <Button type="link" icon={<DownloadOutlined />} onClick={downloadSkill}>下载开发技能</Button>
        </div>
      </section>

      <section className="aap-guide-workspace" aria-label="应用制作操作导航">
        <aside className="aap-guide-progress">
          <div className="aap-guide-progress__label">你的制作路线</div>
          <Progress
            percent={Math.round(((activeStep + 1) / GUIDE_STEPS.length) * 100)}
            showInfo={false}
            strokeColor="#175cd3"
            trailColor="#e4e7ec"
          />
          <div className="aap-guide-progress__count">
            <strong>{String(activeStep + 1).padStart(2, '0')}</strong>
            <span> / {String(GUIDE_STEPS.length).padStart(2, '0')}</span>
          </div>
          <ol>
            {GUIDE_STEPS.map((step, index) => (
              <li
                key={`${step.index}-${step.title}`}
                className={index === activeStep ? 'is-active' : index < activeStep ? 'is-complete' : ''}
                aria-current={index === activeStep ? 'step' : undefined}
              >
                <span>{index < activeStep ? '✓' : String(index + 1).padStart(2, '0')}</span>
                <strong>{step.title}</strong>
              </li>
            ))}
          </ol>
        </aside>

        <article className="aap-guide-step">
          <div className="aap-guide-step__topline">
            <span>第 {activeStep + 1} 步</span>
            <span>{Math.round(((activeStep + 1) / GUIDE_STEPS.length) * 100)}% 已完成</span>
          </div>
          <div className="aap-guide-step__content" key={activeStep}>
            <GuideMarkdown content={currentStep.content} />
          </div>
          <footer className="aap-guide-step__footer">
            <Button type="text" onClick={finishGuide}>跳过</Button>
            <div className="aap-guide-step__controls">
              {activeStep > 0 ? (
                <Button onClick={() => setActiveStep((step) => step - 1)}>上一步</Button>
              ) : null}
              <Button type="primary" icon={<ArrowRightOutlined />} onClick={goNext}>
                {isLastStep ? '完成，前往登录 / 注册' : '下一步'}
              </Button>
            </div>
          </footer>
        </article>
      </section>
    </div>
  );
}
