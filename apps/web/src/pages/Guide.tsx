import { Button, Progress, Typography } from 'antd';
import { ArrowRightOutlined, DownloadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useNavigate } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { useQuery } from '@tanstack/react-query';
import type { PortalBootstrap } from '@aap/shared';
import { api } from '../api/client';
import { useSession } from '../state/session';
import { GUIDE_FAQ_ITEMS } from '../lib/guideFaq';

const GUIDE_MD = [
  '## 一、什么是 ai-app-panel',
  '',
  'ai-app-panel 可以托管你制作的小应用：Agent 负责制作并打包成 awpk 应用包，你上传后即可试用或分享。AWPK 是 ZIP 容器，包含 manifest 和应用文件；平台只接受 awpk，不会兼容旧扩展名或普通 zip。',
  '',
  '开始前准备：',
  '',
  '- 一个可以使用的 ai-app-panel 账号（向管理员申请，或在登录页自行注册）',
  '- 一个支持安装技能、并能运行代码的 AI 助手（Agent）',
  '- 从本页下载并准备 `awpk-app-develop.skill`、`awpk-app-develop.zip`，或 `awpk-app-develop.md`',
  '',
  '## 二、安装开发技能',
  '',
  '使用您习惯的Agent安装awpk-app-develop.skill或awpk-app-develop.zip技能包，若不支持技能包上传则可以将awpk-app-develop.md的内容复制后发给Agent，并告诉它按这份规范开发应用。',
  '',
  '### WorkBuddy',
  '',
  '在 `专家·技能·连接器` 页面选择上传 `awpk-app-develop.zip` 包，检验安全后确认安装。',
  '',
  '### Claude',
  '',
  '在 `Customize` 设置的 `Skills` 页面添加 `awpk-app-develop.skill` 技能包上传成功即可。',
  '',
  '确认已安装：问 Agent“你知道怎么制作并打包awpk应用吗？”，它能识别表示安装成功。',
  '',
  '## 三、让 Agent 做出你的应用',
  '',
  '### 告诉 Agent 你要一个什么应用',
  '',
  '- 帮我做一个全球时钟，显示主要城市的当前时间，并打包成 awpk。',
  '- 帮我做一个文章总结工具，粘贴文章后生成摘要，并打包成 awpk。',
  '- 帮我做一个待办事项网页，可以添加、完成和删除任务，并打包成 awpk。',
  '',
  '### 下载并检查交付物',
  '',
  '下载 Agent 提供的 awpk 文件并阅读交付说明。发现交付物有问题时，告诉 Agent 修复并重新打包。',
  '',
  '## 四、上传到 ai-app-panel',
  '',
  '### 上传应用',
  '',
  '进入「用户中心」的「应用管理」板块，上传 Agent 生成的 awpk。平台检查通过后，应用会出现在「我的应用」页面，默认仅自己可见。',
  '',
  '### 配置应用',
  '',
  '按交付说明在应用配置的「环境变量」中填写所需配置；如需第三方密钥，只填写在环境变量中，不要发给 Agent 或写进页面。',
  '',
  '试运行时，按页面提示填写所需入参。上传或安装失败时，将页面提示原文发给 Agent 修复并重新打包。',
  '',
  '## 五、选择应用的可见范围',
  '',
  '### 先试用',
  '',
  '保持应用为「仅自己可见」，从「我的应用」打开并检查页面和功能。按调用运行的应用，按页面提示填写入参并提交测试。',
  '',
  '试用有问题时，让 Agent 修复并重新上传。',
  '',
  '### 确认正常后发布',
  '',
  '在「用户中心」的「应用管理」板块选择可见范围。确认首页卡片或目标用户可访问后，复制应用链接分享。',
  '',
  '每个账号可创建的应用数量和可克隆站内共享应用数量分别受当前权益包限制，可在「用户中心 → 我的权益」查看；克隆只能设为仅自己可见，删除克隆会归还名额。',
  '',
  '| 可见范围 | 谁能访问 |',
  '| --- | --- |',
  '| 公开 | 所有人 |',
  '| 站内 | 其他用户可在「我的应用 → 站内共享」克隆；不能直接访问 |',
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
  '1. 装技能：使用您习惯的 Agent 安装 awpk-app-develop.skill 或 awpk-app-develop.zip；不支持技能包上传时，将 awpk-app-develop.md 内容复制给 Agent。',
  '2. 说需求：告诉 Agent 想做什么应用，并说明“打包成 awpk”。',
  '3. 下载包：保存 Agent 给你的 awpk 文件，认真看交付说明。',
  '4. 上传：「用户中心 → 应用管理」→ 上传 awpk。',
  '5. 配置：按说明填写环境变量和入参，然后在「我的应用」中试用。',
  '6. 发布分享：确认运行正常后选择公开、站内或仅自己；站内应用不能直接访问，其他用户可克隆到自己的账号。',
].join('\n');

const GUIDE_CHAPTERS = ['一', '二', '三', '四', '五'] as const;
function buildGuideSteps(siteName: string) {
  return GUIDE_MD.replaceAll('ai-app-panel', siteName)
    .split(/(?=^## )/m)
    .map((content) => content.trim())
    .filter(Boolean)
    .slice(0, GUIDE_CHAPTERS.length)
    .map((content, index) => ({
      title: content.match(/^##\s+(.+)$/m)?.[1] ?? `认识${siteName}`,
      content,
      index: GUIDE_CHAPTERS[index] ?? String(index + 1),
    }));
}

function downloadSkill(format: 'skill' | 'zip' | 'md'): void {
  const anchor = document.createElement('a');
  anchor.href = `/api/dev/guide/download?format=${format}`;
  anchor.download = `awpk-app-develop.${format}`;
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
  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api<PortalBootstrap>('/api/portal/bootstrap'),
  });
  const siteName = bootstrap.data?.branding.siteName ?? 'ai-app-panel';
  const guideSteps = buildGuideSteps(siteName);
  const [activeStep, setActiveStep] = useState(0);
  const currentStep = guideSteps[activeStep];
  const isLastStep = activeStep === guideSteps.length - 1;

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
          <span>{guideSteps.length} 个轻松步骤</span>
          <span>·</span>
          <span>随时可以跳过</span>
          <Button type="link" icon={<DownloadOutlined />} onClick={() => downloadSkill('skill')}>下载 .skill</Button>
          <Button type="link" icon={<DownloadOutlined />} onClick={() => downloadSkill('zip')}>下载 .zip</Button>
          <Button type="link" icon={<DownloadOutlined />} onClick={() => downloadSkill('md')}>下载 .md</Button>
        </div>
      </section>

      <section className="aap-guide-workspace" aria-label="应用制作操作导航">
        <aside className="aap-guide-progress">
          <div className="aap-guide-progress__label">你的制作路线</div>
          <Progress
            percent={Math.round(((activeStep + 1) / guideSteps.length) * 100)}
            showInfo={false}
            strokeColor="#175cd3"
            trailColor="#e4e7ec"
          />
          <div className="aap-guide-progress__count">
            <strong>{String(activeStep + 1).padStart(2, '0')}</strong>
            <span> / {String(guideSteps.length).padStart(2, '0')}</span>
          </div>
          <ol>
            {guideSteps.map((step, index) => (
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
            <span>{Math.round(((activeStep + 1) / guideSteps.length) * 100)}% 已完成</span>
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
