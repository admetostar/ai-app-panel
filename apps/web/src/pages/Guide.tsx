import { Button, Progress, Typography } from 'antd';
import { ArrowRightOutlined, DownloadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useNavigate } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { useSession } from '../state/session';
import { GUIDE_FAQ_ITEMS } from '../lib/guideFaq';

const GUIDE_MD = [
  '适合不会编程的普通用户：准备技能和账号，再让 agent 制作、上传、试用并发布应用。',
  '',
  '## 一、了解平台并做好准备',
  '',
  'AI超级面板可以托管你制作的小应用：agent 负责制作并打包成 .asp-app 文件，你上传后即可试用或分享。',
  '',
  '开始前准备：',
  '',
  '- 一个可以使用的 AI超级面板账号（向管理员申请，或在登录页自行注册）',
  '- 一个支持安装技能、并能运行代码的 AI 助手（agent）',
  '- 从本页下载技能文件 `asp-app-develop.skill`',
  '',
  '## 二、安装开发技能',
  '',
  '安装一次即可。根据使用方式选择一种：',
  '',
  '### Claude 网页版 / App',
  '',
  '在设置的技能（Skills）页面上传 `asp-app-develop.skill` 并打开；同时开启代码执行和文件创建。',
  '',
  '### Claude Code 或其他本地 agent',
  '',
  '解压技能包，将 `asp-app-develop` 文件夹放入技能目录：',
  '',
  '- 个人使用：`~/.claude/skills/asp-app-develop/`；项目使用：`项目目录/.claude/skills/asp-app-develop/`。',
  '',
  '### 其他 agent',
  '',
  '如果不支持安装技能，将 `SKILL.md` 内容发给 agent，并告诉它按这份规范开发应用。',
  '',
  '确认安装：问 agent“你知道怎么制作并打包 AI超级面板应用吗？”确认它能识别 .asp-app 即可。',
  '',
  '## 三、让 agent 做出你的应用',
  '',
  '### 告诉agent你要一个什么应用',
  '',
  '- 帮我做一个全球时钟，显示主要城市的当前时间，并打包成 asp-app。',
  '- 帮我做一个文章总结工具，粘贴文章后生成摘要，并打包成 asp-app。',
  '- 帮我做一个待办事项网页，可以添加、完成和删除任务，并打包成 asp-app。',
  '',
  '### 下载并检查交付物',
  '',
  '下载 agent 提供的 `.asp-app` 文件并阅读交付说明。发现交付物有问题时，告诉 agent 修复并重新打包。',
  '',
  '## 四、上传到 AI超级面板',
  '',
  '### 上传并完成配置',
  '',
  '进入用户中心的“我的应用”，上传 agent 生成的 `.asp-app`。平台检查通过后，应用会出现在列表中，默认仅自己可见。',
  '',
  '按交付说明在应用配置的「环境变量」中填写所需配置；如需第三方密钥，只填写在环境变量中，不要发给 agent 或写进页面。',
  '',
  '试运行时，按页面提示填写所需入参。上传或安装失败时，将页面提示原文发给 agent 修复并重新打包。',
  '',
  '## 五、先试用然后发布',
  '',
  '### 先试用',
  '',
  '保持应用为「仅自己可见」，从「我的应用」打开并检查页面和功能。按调用运行的应用，按页面提示填写入参并提交测试。',
  '',
  '试用有问题时，让 agent 修复并重新上传。',
  '',
  '### 确认正常后发布',
  '',
  '在应用管理中将可见范围设为公开。确认首页卡片可见后，复制应用链接分享。',
  '',
  '每个账号可公开发布的数量受订阅限制，可在用户中心 → 我的权益查看。',
  '',
  '| 可见范围 | 谁能访问 |',
  '| --- | --- |',
  '| 公开 | 所有人 |',
  '| 需登录 | 登录用户 |',
  '| 指定分组 / 账号 | 选择的成员 |',
  '| 仅自己 | 只有自己 |',
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
  '2. 说需求：告诉 agent 想做什么应用，并说明“打包成 asp-app”。',
  '3. 下载包：保存 agent 给你的 `.asp-app` 文件，认真看交付说明。',
  '4. 上传并设置：用户中心 → 我的应用 → 上传 `.asp-app` → 选择可见范围。',
  '5. 安装并试运行：等待平台自动安装 → 按说明配置环境变量和入参 → 试运行。',
  '6. 公开分享：确认运行正常后设为公开 → 把访问链接发给对方。',
].join('\n');

const GUIDE_MD_TEXT = GUIDE_MD;

const GUIDE_SECTION_PARTS = GUIDE_MD_TEXT.split(/(?=^## )/m)
  .map((content) => content.trim())
  .filter(Boolean);
const GUIDE_CHAPTERS = ['一', '二', '三', '四', '五'] as const;
const GUIDE_STEPS = [
  GUIDE_SECTION_PARTS.slice(0, 2).join('\n\n'),
  ...GUIDE_SECTION_PARTS.slice(2, 6),
]
  .map((content, index) => {
    const heading = content.match(/^##\s+(.+)$/m)?.[1];
    return {
      title: heading ?? '认识 AI 超级面板',
      content,
      index: GUIDE_CHAPTERS[index] ?? String(index + 1),
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
                <span>{index < activeStep ? '✓' : step.index}</span>
                <strong>{step.title}</strong>
              </li>
            ))}
          </ol>
        </aside>

        <article className="aap-guide-step">
          <div className="aap-guide-step__topline">
            <span>章节 {currentStep.index}</span>
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
