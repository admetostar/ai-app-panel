import { Typography } from 'antd';
import { Link } from 'react-router-dom';

export function TermsPage() {
  return (
    <main className="aap-legal-page">
      <Typography.Title level={2}>Terms of Service</Typography.Title>
      <Typography.Paragraph type="secondary">服务条款 · 最后更新：2026 年 10 月 30 日</Typography.Paragraph>
      <Typography.Title level={4}>使用平台</Typography.Title>
      <Typography.Paragraph>
        使用本平台即表示你同意遵守本条款、Acceptable Use Policy 及适用法律。你需要妥善保管账号凭据，并对通过账号进行的操作负责。
      </Typography.Paragraph>
      <Typography.Title level={4}>应用与内容</Typography.Title>
      <Typography.Paragraph>
        你保留自己提交内容的权利，并负责确保拥有发布和分享这些内容所需的权利。平台可按可见性、订阅权益和安全规则提供应用托管与访问服务。
      </Typography.Paragraph>
      <Typography.Title level={4}>服务可用性</Typography.Title>
      <Typography.Paragraph>
        平台按当前状态提供服务。维护、安全处置或不可抗力可能导致服务暂时中断；我们会在合理范围内维护服务并保护账号数据。
      </Typography.Paragraph>
      <Typography.Title level={4}>账号与终止</Typography.Title>
      <Typography.Paragraph>
        违反本条款、可接受使用政策或法律的行为可能导致内容被限制、账号被暂停或访问被终止。你可以按个人中心提供的流程申请注销账号。
      </Typography.Paragraph>
      <Typography.Paragraph>
        如本条款与适用法律冲突，以适用法律为准。具体法律要求请由站点运营者根据其部署地区补充审阅。
      </Typography.Paragraph>
      <div className="aap-legal-links">
        <Link to="/acceptable-use">查看 Acceptable Use Policy</Link>
        <Link to="/">返回首页</Link>
      </div>
    </main>
  );
}
