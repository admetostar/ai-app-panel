import { Typography } from 'antd';
import { Link } from 'react-router-dom';

export function AcceptableUsePage() {
  return (
    <main className="aap-legal-page">
      <Typography.Title level={2}>Acceptable Use Policy</Typography.Title>
      <Typography.Paragraph type="secondary">可接受使用政策 · 最后更新：2026 年 10 月 30 日</Typography.Paragraph>
      <Typography.Paragraph>
        使用平台、运行或分享应用时，你必须遵守适用法律和本政策。以下行为不被允许：
      </Typography.Paragraph>
      <ul>
        <li>侵犯他人的隐私、知识产权或其他合法权益，或未经授权访问系统和数据。</li>
        <li>发布恶意软件、诈骗内容、垃圾信息，或用于骚扰、跟踪、威胁他人的应用。</li>
        <li>绕过身份验证、访问控制、额度限制、沙箱或网络安全边界。</li>
        <li>干扰平台或其他用户的服务，包括滥用资源、拒绝服务或探测未授权目标。</li>
        <li>托管或传播违法、有害或未经授权的内容。</li>
      </ul>
      <Typography.Paragraph>
        站点运营者可调查涉嫌违规行为，并根据风险采取内容下架、访问限制或账号暂停等措施。若发现安全问题，请通过站点公开的联系渠道报告。
      </Typography.Paragraph>
      <div className="aap-legal-links">
        <Link to="/terms">查看 Terms of Service</Link>
        <Link to="/">返回首页</Link>
      </div>
    </main>
  );
}
