/** 管理后台页面与设置面板。 */
import type { ChangeEvent, ReactNode } from 'react';
import { withBase } from '../lib/base';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Collapse,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Steps,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { isPasswordValid, PASSWORD_POLICY_MESSAGE } from '@aap/shared';
import { useEffect, useRef, useState } from 'react';
import { CopyOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { appVisibilityBadgeSrc, appVisibilityLabel } from '../lib/appVisibility';
import { useSession } from '../state/session';
import { AppEnvModal } from '../components/AppEnvModal';
import { TierBadge } from '../components/TierBadge';
import { formatEntitlementCount, formatMembershipOrderPrice, formatMembershipPlanPrice } from '../lib/membershipPricing';
import type { PublicUser } from '@aap/shared';

// ---------- 类型 ----------

interface AdminApp {
  id: string;
  name: string;
  description: string;
  category: string;
  visibility: 'public' | 'login' | 'private';
  passUser: boolean;
  upstream: string;
  kind: 'upstream' | 'html' | 'package';
  ownerUserId: number | null;
  hasUrlSecret: boolean;
  enabled: boolean;
  sort: number;
  healthState: 'ok' | 'down' | 'unknown';
  lastProbeAt: number | null;
  allowGroupIds: number[];
  allowUserIds: number[];
}
interface GroupRow {
  id: number;
  name: string;
  note: string;
  appPublishRewardPoints: number;
  memberCount: number;
}
interface SettingRow {
  key: string;
  value: string;
  label: string;
  type: 'string' | 'int' | 'bool';
  group: string;
  options?: string[];
  choiceLabels?: Record<string, string>;
  exclusiveOf?: string;
  desc: string;
  secret: boolean;
  advanced: boolean;
  defaultsWork: boolean;
}
interface Overview {
  totals: {
    users: number;
    apps: number;
    tokens30d: number;
  };
  resources: {
    cpuPercent: number | null;
    memory: { usedBytes: number; totalBytes: number; percent: number };
    network: {
      available: boolean;
      receiveMbps: number;
      sendMbps: number;
      percent: number;
      capacityMbps: number;
      reason?: string;
    };
  };
  planSubscriptions: Array<{ planId: number; planName: string; subscribers: number }>;
}
interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  ip: string | null;
  action: string;
  detail: unknown;
}
interface AppRuntimeEvent {
  id: number;
  appId: string;
  ts: number;
  level: 'info' | 'warn' | 'error';
  event: string;
  userId: number | null;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  durationMs: number | null;
  details: unknown;
}
interface Invite {
  code: string;
  ownerUserId: number;
  ownerUsername: string | null;
  ownerEmail: string | null;
  ownerName: string;
  enabled: boolean;
  useCount: number;
  createdAt: number;
}

function dot(state: string): ReactNode {
  const color = state === 'ok' || state === 'green' ? '#52c41a' : state === 'down' ? '#ff4d4f' : '#faad14';
  const label = state === 'ok' || state === 'green' ? '正常' : state === 'down' ? '异常' : '未知';
  return <Badge color={color} text={label} />;
}

// ---------- 通用：分组配置表单（③一句话说明 + 默认值标注；⑦保存即生效） ----------

function SettingsForm({
  groups,
  excludeKeys = [],
  banners,
}: {
  groups: string[];
  excludeKeys?: string[];
  /** 按组名渲染在配置项上方的提示块（如 OIDC 回调地址） */
  banners?: Record<string, ReactNode>;
}): ReactNode {
  const qc = useQueryClient();
  const settingsQ = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => api<{ settings: SettingRow[] }>('/api/admin/settings'),
  });
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (settingsQ.data) {
      const values: Record<string, string | boolean> = {};
      for (const s of settingsQ.data.settings) {
        // bool 项规范为真布尔（Switch 需要布尔；字符串真值判断不可靠）
        values[s.key] = s.type === 'bool' ? s.value === 'true' : s.value;
      }
      form.setFieldsValue(values);
    }
  }, [settingsQ.data, form]);

  // 互斥（如 MAIL_PROVIDER=smtp|resend）：只显示选中方式的配置
  const provider = Form.useWatch('MAIL_PROVIDER', form) ?? (settingsQ.data?.settings.find((s) => s.key === 'MAIL_PROVIDER')?.value ?? 'smtp');
  const all = (settingsQ.data?.settings ?? []).filter((s) => {
    if (excludeKeys.includes(s.key)) return false;
    if (s.exclusiveOf === 'MAIL_PROVIDER') {
      return s.key.toUpperCase().startsWith(provider.toUpperCase());
    }
    return true;
  });

  const ordered: Array<[string, SettingRow[]]> = groups.map((g) => [
    g,
    all.filter((s) => s.group === g),
  ]);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const values = form.getFieldsValue() as Record<string, string | boolean>;
      const payload: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined || v === null) continue;
        payload[k] = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
      }
      await api('/api/admin/settings', { method: 'PUT', json: payload });
      message.success('已保存并即时生效');
      void qc.invalidateQueries({ queryKey: ['admin-settings'] });
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function uploadLogo(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';
    if (file.size > 5 * 1024 * 1024) {
      message.error('Logo 图片不能超过 5 MB');
      return;
    }

    setLogoUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
        reader.onload = () => {
          if (typeof reader.result !== 'string') {
            reject(new Error('读取图片失败'));
            return;
          }
          resolve(reader.result);
        };
        reader.readAsDataURL(file);
      });
      const dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const result = await api<{ path: string }>('/api/admin/site-logo', {
        method: 'POST',
        json: { dataBase64 },
      });
      form.setFieldsValue({ LOGO: result.path });
      message.success('Logo 已上传，请保存站点设置后生效');
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Logo 上传失败');
    } finally {
      setLogoUploading(false);
    }
  }

  function renderItem(s: SettingRow): ReactNode {
    return (
      <Form.Item
        key={s.key}
        name={s.key}
        label={s.label}
        tooltip={s.desc}
        valuePropName={s.type === 'bool' ? 'checked' : 'value'}
      >
        {s.key === 'LOGO' ? (
          <Input
            placeholder={s.defaultsWork ? '（默认值即可）' : ''}
            addonAfter={
              <>
                <Button
                  type="link"
                  loading={logoUploading}
                  disabled={logoUploading}
                  onClick={() => logoInputRef.current?.click()}
                >
                  上传
                </Button>
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  onChange={(event) => void uploadLogo(event)}
                  style={{ display: 'none' }}
                />
              </>
            }
          />
        ) : renderControl(s, form)}
      </Form.Item>
    );
  }

  return (
    <Form form={form} layout="vertical">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {ordered.map(([g, items]) =>
          items.length > 0 ? (
            <Card key={g} size="small" title={g} extra={<Tag bordered={false} style={{ fontSize: 11 }}>{items.length} 项</Tag>}>
              {banners?.[g]}
              {items.map(renderItem)}
            </Card>
          ) : null,
        )}
        <Button type="primary" loading={saving} onClick={() => void save()}>
          保存（即时生效）
        </Button>
      </Space>
    </Form>
  );
}

// ---------- 配置控件渲染（下拉/开关/取色/数字/密码+查看） ----------

const KEY_WIDGET: Record<string, string> = {
  AAP_SIGN_SECRET: 'password',
  TURNSTILE_SECRET_KEY: 'password',
  SMTP_PASS: 'password',
  RESEND_API_KEY: 'password',
};

function renderControl(s: SettingRow, form?: { setFieldsValue: (v: Record<string, unknown>) => void }, secretReveal = false): ReactNode {
  if (s.type === 'bool') return <Switch />;
  if (s.choiceLabels) {
    return <Select options={Object.entries(s.choiceLabels).map(([value, label]) => ({ value, label }))} />;
  }
  if (s.secret || KEY_WIDGET[s.key] === 'password') {
    const reveal = secretReveal ? (
      <Button
        onClick={() =>
          Modal.confirm({
            title: `查看密钥：${s.key}`,
            content: '查看操作会记入审计日志。确认继续？',
            okText: '查看',
            onOk: async () => {
              try {
                const r = await api<{ value: string }>(`/api/admin/secrets/${s.key}`);
                form?.setFieldsValue({ [s.key]: r.value });
                message.success('已填入表单（可复制）');
              } catch (err) {
                message.error(err instanceof Error ? err.message : '获取失败');
              }
            },
          })
        }
      >
        查看
      </Button>
    ) : null;
    return (
      <Space.Compact style={{ width: '100%' }}>
        <Input.Password placeholder="留空保持不变" autoComplete="new-password" />
        {reveal}
      </Space.Compact>
    );
  }
  if (s.type === 'int') {
    return s.key === 'REGISTRATION_POINTS_GIFT'
      ? <InputNumber min={0} max={2_147_483_647} precision={0} style={{ width: 160 }} />
      : <InputNumber style={{ width: 160 }} />;
  }
  return <Input placeholder={s.defaultsWork ? '（默认值即可）' : ''} />;
}

// ---------- 主页面 ----------

const ADMIN_TABS = ['overview', 'site', 'apps', 'users', 'security', 'mail', 'tls', 'llm', 'ops'] as const;

export function AdminPage() {
  const { me } = useSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const activeTab = ADMIN_TABS.find((tab) => tab === requestedTab) ?? 'overview';

  useEffect(() => {
    if (requestedTab && requestedTab !== activeTab) navigate('/admin?tab=overview', { replace: true });
  }, [activeTab, navigate, requestedTab]);

  if (!me || me.user.role !== 'admin') {
    return <Alert type="warning" showIcon message="需要管理员权限" description={<a href={withBase('/login')}>使用管理员账号登录</a>} />;
  }

  return (
    <div className="aap-account-page aap-admin-page">
      <header className="aap-account-heading">
        <Typography.Text className="aap-account-eyebrow">系统运营</Typography.Text>
        <Typography.Title level={2}>管理后台</Typography.Title>
        <Typography.Paragraph type="secondary">管理站点、应用、用户与运行服务。</Typography.Paragraph>
      </header>
      <div className="aap-admin-content">
        {activeTab === 'overview' ? <OverviewTab /> : null}
        {activeTab === 'site' ? <SettingsForm groups={['站点与品牌']} /> : null}
        {activeTab === 'apps' ? <AppsTab /> : null}
        {activeTab === 'users' ? <UsersRegTab /> : null}
        {activeTab === 'security' ? <SecurityTab /> : null}
        {activeTab === 'mail' ? <MailTab /> : null}
        {activeTab === 'tls' ? <TlsTab /> : null}
        {activeTab === 'llm' ? <LlmTab /> : null}
        {activeTab === 'ops' ? <OpsTab /> : null}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return `${gib >= 10 ? gib.toFixed(1) : gib.toFixed(2)} GiB`;
}

function uncappedProgress(value: number): number {
  return value > 0 ? Math.min(96, Math.log10(value + 1) * 10) : 0;
}

function WaterLevelCard({
  title,
  percent,
  value,
  detail,
}: {
  title: string;
  percent: number | null;
  value: string;
  detail: string;
}): ReactNode {
  const safePercent = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <Card className="aap-admin-resource-card">
      <Typography.Text type="secondary">{title}</Typography.Text>
      <div className="aap-admin-water-level">
        <div className="aap-admin-water-level__tank" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent == null ? undefined : Math.round(safePercent)}>
          <div className="aap-admin-water-level__fill" style={{ height: `${safePercent}%` }} />
          <span>{percent == null ? '采集中' : `${safePercent.toFixed(1)}%`}</span>
        </div>
        <div className="aap-admin-water-level__value">
          <Typography.Title level={3}>{value}</Typography.Title>
          <Typography.Text type="secondary">{detail}</Typography.Text>
        </div>
      </div>
    </Card>
  );
}

function SubscriptionPie({ plans }: { plans: Overview['planSubscriptions'] }): ReactNode {
  const total = plans.reduce((sum, plan) => sum + plan.subscribers, 0);
  const colors = ['#1677ff', '#13c2c2', '#722ed1', '#fa8c16', '#eb2f96', '#52c41a', '#2f54eb'];
  let current = 0;
  const segments = plans.map((plan, index) => {
    const start = current;
    current += total > 0 ? (plan.subscribers / total) * 100 : 0;
    return `${colors[index % colors.length]} ${start}% ${current}%`;
  });
  const background = total > 0 ? `conic-gradient(${segments.join(', ')})` : '#d9d9d9';

  return (
    <Card title="订阅计划分布">
      <div className="aap-admin-subscriptions">
        <div className="aap-admin-subscriptions__chart" role="img" aria-label={`有效订阅用户总数 ${total}，按计划分布`} style={{ background }}>
          <div className="aap-admin-subscriptions__total">
            <strong>{total.toLocaleString()}</strong>
            <span>有效订阅</span>
          </div>
        </div>
        <div className="aap-admin-subscriptions__legend">
          {plans.length ? plans.map((plan, index) => (
            <div className="aap-admin-subscriptions__legend-row" key={plan.planId}>
              <span className="aap-admin-subscriptions__swatch" style={{ background: colors[index % colors.length] }} />
              <span className="aap-admin-subscriptions__name">{plan.planName}</span>
              <strong>{plan.subscribers.toLocaleString()}</strong>
            </div>
          )) : <Typography.Text type="secondary">暂无订阅计划</Typography.Text>}
        </div>
      </div>
    </Card>
  );
}

function OverviewTab(): ReactNode {
  const overview = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => api<Overview>('/api/admin/overview'),
    refetchInterval: 5_000,
  });
  const data = overview.data;
  const network = data?.resources.network;

  if (overview.isPending) return <Card loading />;
  if (overview.isError || !data) {
    return <Alert type="error" showIcon message="无法加载系统总览" description={overview.error instanceof Error ? overview.error.message : '请稍后重试。'} />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <section>
        <Typography.Title level={4}>系统资源</Typography.Title>
        <div className="aap-admin-resource-grid">
          <WaterLevelCard title="CPU 使用率" percent={data.resources.cpuPercent} value={data.resources.cpuPercent == null ? '采集中' : `${data.resources.cpuPercent.toFixed(1)}%`} detail="主机当前负载" />
          <WaterLevelCard title="内存使用率" percent={data.resources.memory.percent} value={`${data.resources.memory.percent.toFixed(1)}%`} detail={`${formatBytes(data.resources.memory.usedBytes)} / ${formatBytes(data.resources.memory.totalBytes)}`} />
          <WaterLevelCard
            title="网络带宽"
            percent={network?.available ? network.percent : null}
            value={network?.available ? `${(network.receiveMbps + network.sendMbps).toFixed(2)} Mbps` : '暂不可用'}
            detail={network?.available
              ? `下行 ${network.receiveMbps.toFixed(2)} / 上行 ${network.sendMbps.toFixed(2)} Mbps · 上限 ${network.capacityMbps} Mbps`
              : network?.reason ?? '当前系统未提供带宽计数器'}
          />
        </div>
      </section>

      <section>
        <Typography.Title level={4}>平台累计</Typography.Title>
        <Typography.Paragraph className="aap-admin-metric-hint" type="secondary">
          数值无固定上限；进度条按数量级映射，仅用于快速观察趋势。
        </Typography.Paragraph>
        <div className="aap-admin-total-grid">
          {[
            { label: '注册用户总数', value: data.totals.users },
            { label: '创建应用总数', value: data.totals.apps },
            { label: '近 30 天 Token 消耗', value: data.totals.tokens30d },
          ].map((metric) => (
            <Card className="aap-admin-total-card" key={metric.label}>
              <Typography.Text type="secondary">{metric.label}</Typography.Text>
              <Typography.Title level={2}>{metric.value.toLocaleString()}</Typography.Title>
              <Progress percent={uncappedProgress(metric.value)} showInfo={false} />
            </Card>
          ))}
        </div>
      </section>

      <SubscriptionPie plans={data.planSubscriptions} />
    </Space>
  );
}

// ---------- 应用管理（应用列表 + 网关限流配置） ----------

interface PkgPreview {
  id: string;
  displayName: string;
  version: string;
  type: string;
  runtime: string | null;
  capabilities: string[];
  network: string[];
  requirements?: string[];
  exists: boolean;
  existingKind: string | null;
  env?: Array<{ name: string; required: boolean; secret: boolean; description: string }>;
}

function AppsTab(): ReactNode {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<AdminApp | null>(null);
  const [creating, setCreating] = useState<null | 'upstream' | 'html' | 'package'>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [visMode, setVisMode] = useState<string>('login');
  const [pkgFile, setPkgFile] = useState<{ name: string; dataBase64: string } | null>(null);
  const [pkgPreview, setPkgPreview] = useState<PkgPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [packageSubmitting, setPackageSubmitting] = useState(false);
  const [envApp, setEnvApp] = useState<AdminApp | null>(null);
  const [runtimeAppId, setRuntimeAppId] = useState('');
  const [runtimeLevel, setRuntimeLevel] = useState('');

  const appsQ = useQuery({ queryKey: ['admin-apps'], queryFn: () => api<{ apps: AdminApp[]; signSecret?: string }>('/api/admin/apps') });
  const runtimeEventsQ = useQuery({
    queryKey: ['admin-app-runtime-events', runtimeAppId, runtimeLevel],
    queryFn: () => api<{ events: AppRuntimeEvent[] }>(
      `/api/admin/apps/runtime-events?limit=200${runtimeAppId ? `&appId=${encodeURIComponent(runtimeAppId)}` : ''}${runtimeLevel ? `&level=${runtimeLevel}` : ''}`,
    ),
    refetchInterval: 30_000,
  });
  // passUser 开关实时跟随表单；勾选时展示身份签名密钥供上游应用复制
  const passUserOn = Form.useWatch('passUser', form);
  const signSecret = appsQ.data?.signSecret ?? '';

  const VIS_OPTIONS = [
    { value: 'public', label: '公开（免登录）' },
    { value: 'login', label: '站内（其他用户可克隆，不可直接访问）' },
    { value: 'private', label: '仅自己（私有）' },
  ];

  async function saveApp(values: Record<string, unknown>): Promise<void> {
    try {
      if (creating === 'html') {
        await api('/api/admin/apps/html', { method: 'POST', json: values });
        message.success('HTML 应用已接入并生效');
      } else {
        await api('/api/admin/apps', { method: 'POST', json: values });
        message.success('应用已接入并生效');
      }
      setCreating(null);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['admin-apps'] });
      void qc.invalidateQueries({ queryKey: ['apps'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    }
  }

  async function uploadPackage(): Promise<void> {
    if (packageSubmitting) return;
    if (!pkgFile) {
      message.warning('请先选择 .awpk 包文件');
      return;
    }
    setPackageSubmitting(true);
    try {
      const values = form.getFieldsValue() as { passUser?: boolean; urlSecret?: string; visibility?: string };
      const r = await api<{ app: Record<string, unknown>; llmProvisioned: boolean }>('/api/admin/apps/package', {
        method: 'POST',
        json: {
          filename: pkgFile.name,
          dataBase64: pkgFile.dataBase64,
          visibility: values.visibility ?? 'private',
          passUser: values.passUser ?? false,
          urlSecret: values.urlSecret || undefined,
        },
      });
      setPkgPreview(null);
      setCreating(null);
      form.resetFields();
      message.success(
        `已接入：${String(r.app.displayName)} v${String(r.app.version)}（${String(r.app.type)}）` +
          (r.llmProvisioned ? '；已自动签发 LLM 网关凭据' : ''),
        6,
      );
      void qc.invalidateQueries({ queryKey: ['admin-apps'] });
      void qc.invalidateQueries({ queryKey: ['apps'] });
      void qc.invalidateQueries({ queryKey: ['llm-tokens'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '包校验失败');
    } finally {
      setPackageSubmitting(false);
    }
  }

  async function testApp(app: AdminApp): Promise<void> {
    setTestResult((r) => ({ ...r, [app.id]: '测试中…' }));
    try {
      const r = await api<{ ok: boolean; status?: number; latencyMs?: number; error?: string }>(
        `/api/admin/apps/${app.id}/test`,
        { method: 'POST' },
      );
      setTestResult((prev) => ({
        ...prev,
        [app.id]: r.ok ? `✓ ${app.id} 可达（${r.status}，${r.latencyMs}ms）` : `✗ ${app.id}：${r.error ?? r.status}`,
      }));
      void qc.invalidateQueries({ queryKey: ['admin-apps'] });
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [app.id]: err instanceof Error ? err.message : '测试失败' }));
    }
  }

  async function saveEdit(values: Record<string, unknown>): Promise<void> {
    if (!editing) return;
    try {
      await api(`/api/admin/apps/${editing.id}`, {
        method: 'PUT',
        json: {
          name: values.name,
          description: values.description,
          visibility: values.visibility,
          passUser: values.passUser,
          ...(values.urlSecret ? { urlSecret: values.urlSecret } : {}),
          ...(editing.kind === 'upstream' ? { upstream: values.upstream } : {}),
          ...(editing.kind === 'html' && values.html !== undefined ? { html: String(values.html) } : {}),
        },
      });
      message.success('已保存并生效');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['admin-apps'] });
      void qc.invalidateQueries({ queryKey: ['apps'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    }
  }

  const KIND_LABEL: Record<string, string> = { upstream: '反代', html: 'HTML', package: '包' };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title="应用列表"
        extra={
          <Space size="small">
            <Button type="primary" onClick={() => { form.resetFields(); setVisMode('login'); setPkgFile(null); setPkgPreview(null); setEditing(null); setCreating('upstream'); }}>接入上游应用</Button>
            <Button onClick={() => { form.resetFields(); setVisMode('login'); setEditing(null); setCreating('html'); }}>接入 HTML 页</Button>
            <Button onClick={() => { form.resetFields(); setVisMode('private'); setPkgFile(null); setPkgPreview(null); setEditing(null); setCreating('package'); }}>上传 .awpk</Button>
          </Space>
        }
      >
        <Table<AdminApp>
          rowKey="id"
          dataSource={appsQ.data?.apps ?? []}
          pagination={false}
          size="small"
          columns={[
            { title: 'ID', dataIndex: 'id', width: 120 },
            { title: '名称', dataIndex: 'name', width: 130 },
            { title: '形态', width: 90, render: (_, r) => <Tag>{KIND_LABEL[r.kind] ?? r.kind}</Tag> },
            { title: '上游', dataIndex: 'upstream', ellipsis: true, render: (v: string) => v || '—' },
            {
              title: '可见性',
              width: 120,
              render: (_, r) => <img className="aap-visibility-badge" src={appVisibilityBadgeSrc(r.visibility, 'list')} alt={appVisibilityLabel(r.visibility)} title={appVisibilityLabel(r.visibility)} />,
            },
            { title: '健康', width: 90, render: (_, r) => dot(r.healthState) },
            {
              title: '操作',
              width: 230,
              render: (_, r) => (
                <Space size="small" wrap>
                  {r.kind === 'upstream' ? <Button size="small" onClick={() => void testApp(r)}>测试</Button> : null}
                  {r.kind === 'package' ? (
                    <Button size="small" onClick={() => setEnvApp(r)}>
                      环境变量
                    </Button>
                  ) : null}
                  <Button
                    size="small"
                    onClick={() => {
                      setEditing(r);
                      setVisMode(r.visibility);
                      form.setFieldsValue({ ...r, urlSecret: undefined, html: undefined });
                      // HTML 托管应用：拉取当前页面代码预填（编辑内容保存即生效）
                      if (r.kind === 'html') {
                        void api<{ html: string }>(`/api/admin/apps/${r.id}/html`)
                          .then((res) => form.setFieldsValue({ html: res.html }))
                          .catch(() => undefined);
                      }
                    }}
                  >
                    编辑
                  </Button>
                  <Popconfirm
                    title={`删除应用「${r.name}」？`}
                    description="门户将立即无法访问该应用。"
                    onConfirm={async () => {
                      await api(`/api/admin/apps/${r.id}`, { method: 'DELETE' });
                      message.success('已删除');
                      void qc.invalidateQueries({ queryKey: ['admin-apps'] });
                      void qc.invalidateQueries({ queryKey: ['apps'] });
                    }}
                  >
                    <Button size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        {Object.entries(testResult).filter(([, v]) => v).map(([k, v]) => (
          <div key={k} style={{ color: 'var(--aap-text-secondary)', fontSize: 12, marginTop: 4 }}>{v}</div>
        ))}
      </Card>

      <Card
        size="small"
        title="应用运行事件（最近 200 条）"
        extra={
          <Space size="small">
            <Select
              allowClear
              placeholder="全部应用"
              value={runtimeAppId || undefined}
              onChange={(value) => setRuntimeAppId(String(value ?? ''))}
              options={(appsQ.data?.apps ?? []).map((app) => ({ value: app.id, label: `${app.name}（${app.id}）` }))}
              style={{ minWidth: 200 }}
            />
            <Select
              allowClear
              placeholder="全部级别"
              value={runtimeLevel || undefined}
              onChange={(value) => setRuntimeLevel(String(value ?? ''))}
              options={[
                { value: 'error', label: '错误' },
                { value: 'warn', label: '警告' },
                { value: 'info', label: '信息' },
              ]}
              style={{ width: 110 }}
            />
            <Button size="small" loading={runtimeEventsQ.isFetching} onClick={() => void runtimeEventsQ.refetch()}>刷新</Button>
          </Space>
        }
      >
        {runtimeEventsQ.isError ? <Alert type="error" showIcon message="运行事件加载失败" description={runtimeEventsQ.error instanceof Error ? runtimeEventsQ.error.message : '请稍后重试'} /> : null}
        <Table<AppRuntimeEvent>
          rowKey="id"
          size="small"
          dataSource={runtimeEventsQ.data?.events ?? []}
          loading={runtimeEventsQ.isLoading}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          scroll={{ x: 1000 }}
          columns={[
            { title: '时间', width: 160, render: (_, row) => new Date(row.ts).toLocaleString() },
            { title: '应用', dataIndex: 'appId', width: 150, ellipsis: true },
            {
              title: '级别',
              dataIndex: 'level',
              width: 80,
              render: (level: AppRuntimeEvent['level']) => <Tag color={level === 'error' ? 'red' : level === 'warn' ? 'orange' : 'blue'}>{level.toUpperCase()}</Tag>,
            },
            { title: '事件', dataIndex: 'event', width: 150 },
            { title: '用户', dataIndex: 'userId', width: 75, render: (value: number | null) => value ?? '—' },
            {
              title: '请求',
              width: 240,
              render: (_, row) => row.method ? <Typography.Text code>{row.method} {row.path}</Typography.Text> : '—',
            },
            { title: '状态', dataIndex: 'statusCode', width: 75, render: (value: number | null) => value ?? '—' },
            { title: '耗时', dataIndex: 'durationMs', width: 85, render: (value: number | null) => value == null ? '—' : `${value} ms` },
            {
              title: '详情',
              ellipsis: true,
              render: (_, row) => row.details ? <Typography.Text code style={{ fontSize: 11 }}>{JSON.stringify(row.details)}</Typography.Text> : '—',
            },
          ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          记录应用进程生命周期、HTTP 错误及耗时至少 1 秒的请求；请求超时会在 25 秒内返回 504 并记录事件。不保存请求/响应正文、Cookie 或认证信息。保留期限沿用“审计保留（天）”设置。
        </Typography.Text>
      </Card>

      <AppEnvModal appId={envApp?.id ?? ''} appName={envApp?.name ?? ''} open={envApp != null} onClose={() => setEnvApp(null)} />

      <Card size="small" title="网关限流与超时" extra={<Tag bordered={false} color="green" style={{ fontSize: 11 }}>默认值即可跑</Tag>}>
        <SettingsForm groups={['应用网关']} />
      </Card>

      {/* 接入 / 编辑 弹窗 */}
      <Modal
        title={editing ? `编辑应用：${editing.name}` : creating === 'html' ? '接入 HTML 页' : creating === 'package' ? '上传 .awpk 包' : '接入上游应用'}
        open={Boolean(creating) || Boolean(editing)}
        onCancel={() => {
          if (packageSubmitting) return;
          setCreating(null);
          setEditing(null);
        }}
        footer={null}
        width={580}
        destroyOnClose
        maskClosable={!packageSubmitting}
      >
        <Form form={form} layout="vertical" onFinish={creating === 'package' ? uploadPackage : editing ? saveEdit : saveApp}>
          {!editing && creating !== 'package' ? (
            <Form.Item
              name="id"
              label="应用 ID（URL 前缀）"
              rules={[{ required: true, message: '必填' }, { pattern: /^[a-z0-9][a-z0-9-]*$/, message: '小写字母/数字/连字符' }]}
              extra="访问地址为 https://你的域名/app/<ID>/"
            >
              <Input disabled={Boolean(editing)} placeholder="my-app" />
            </Form.Item>
          ) : null}
          {creating !== 'package' ? (
            <Form.Item name="name" label="应用名称" rules={[{ required: true, message: '必填' }]}>
              <Input placeholder="应用名" />
            </Form.Item>
          ) : null}
          <Form.Item name="description" label="描述" extra="显示在门户卡片上">
            <Input placeholder="一句话介绍" />
          </Form.Item>

          {creating === 'package' ? (
            <Form.Item label="应用包（.awpk）" required extra="AWPK 是 ZIP 容器；平台会校验 manifest，并在安装时处理 Python 依赖">
              <input
                type="file"
                accept=".awpk"
                disabled={previewing || packageSubmitting}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    const dataBase64 = String(reader.result).split(',')[1] ?? '';
                    setPkgFile({ name: f.name, dataBase64 });
                    setPkgPreview(null);
                    setPreviewing(true);
                    void api<PkgPreview>('/api/admin/apps/package/preview', { method: 'POST', json: { filename: f.name, dataBase64 } })
                      .then((res) => setPkgPreview(res))
                      .catch((err) => {
                        setPkgFile(null);
                        message.error(err instanceof Error ? err.message : '包预解析失败');
                      })
                      .finally(() => setPreviewing(false));
                  };
                  reader.readAsDataURL(f);
                }}
              />
              {pkgFile ? (
                <div style={{ fontSize: 12, color: 'var(--aap-text-secondary)' }}>
                  已选择：{pkgFile.name}
                  {previewing ? ' · 解析中…' : ''}
                </div>
              ) : null}
              {pkgPreview ? (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginTop: 8 }}
                  message={`包解析完成，可安装：${pkgPreview.displayName}（ID: ${pkgPreview.id}）v${pkgPreview.version} · ${pkgPreview.type === 'html' ? 'HTML 包' : `Python ${pkgPreview.runtime === 'persistent' ? '持久服务' : '按调用'}`}`}
                  description={
                    <div style={{ fontSize: 12 }}>
                      <div>能力：{pkgPreview.capabilities.length ? pkgPreview.capabilities.join('、') : '无'}；出网白名单：{pkgPreview.network.length ? pkgPreview.network.join('、') : '无'}</div>
                      {pkgPreview.requirements?.length ? (
                        <div>pip 依赖（接入时自动安装到应用目录）：{pkgPreview.requirements.join('、')}</div>
                      ) : null}
                      {pkgPreview.env?.length ? (
                        <div>
                          环境变量：{pkgPreview.env.map((v) => `${v.name}${v.secret ? '（密钥）' : ''}${v.required ? '' : '（可选）'}`).join('、')}——接入后在应用列表「环境变量」中配置
                        </div>
                      ) : null}
                      <div>包签名：不要求；上传时校验 ZIP 结构与 manifest。</div>
                      {pkgPreview.exists ? <div>同名应用已存在：接入将作为版本更新（仅归属者/管理员可提交）。</div> : null}
                    </div>
                  }
                />
              ) : null}
            </Form.Item>
          ) : null}

          {creating === 'upstream' || editing?.kind === 'upstream' ? (
            <Form.Item
              name="upstream"
              label="上游地址"
              rules={[{ required: true, message: '必填' }]}
              extra="仅允许本机/内网地址，如 http://127.0.0.1:8001"
            >
              <Input placeholder="http://127.0.0.1:8001" />
            </Form.Item>
          ) : null}

          {creating === 'html' || editing?.kind === 'html' ? (
            <Form.Item
              name="html"
              label={editing ? '页面 HTML（保存即生效）' : '页面 HTML'}
              rules={[{ required: true, message: '请填写页面内容' }]}
              extra="门户直接托管在 /app/<ID>/ 下；整页粘贴即可"
            >
              <Input.TextArea rows={12} placeholder="<!doctype html>…" style={{ fontFamily: 'monospace', fontSize: 12 }} />
            </Form.Item>
          ) : null}

          {creating !== 'package' || pkgFile ? (
            <>
              <Form.Item name="visibility" label="可见性" initialValue={visMode}>
                <Select options={VIS_OPTIONS} onChange={(v) => setVisMode(String(v))} />
              </Form.Item>
              <Form.Item name="passUser" label="注入用户身份" valuePropName="checked" extra="向应用转发 X-AAP-Identity 签名头（自研应用识别登录用户）">
                <Switch />
              </Form.Item>
              {passUserOn ? (
                <Form.Item
                  label="身份签名密钥"
                  extra=".aap 包沙箱已自动注入 AAP_SIGN_SECRET，无需配置；接入上游应用时复制此值到其环境变量 AAP_SIGN_SECRET。后台轮换后需重启应用生效。"
                >
                  <Space.Compact style={{ width: '100%' }}>
                    <Input readOnly value={signSecret} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                    <Button
                      onClick={() => {
                        void navigator.clipboard?.writeText(signSecret);
                        message.success('已复制');
                      }}
                    >
                      复制
                    </Button>
                  </Space.Compact>
                </Form.Item>
              ) : null}
              <Form.Item
                name="urlSecret"
                label="上游凭据（可选）"
                extra='如 "token=xxx" 或 "__path__=/chat/xxx"，加密存储不下发'
              >
                <Input placeholder="token=xxx" />
              </Form.Item>
            </>
          ) : null}

          {creating === 'package' ? (
            <>
              {packageSubmitting ? (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="正在校验并接入应用包"
                  description={
                    pkgPreview?.requirements?.length
                      ? `正在安装 Python 依赖：${pkgPreview.requirements.join('、')}。最长约 5 分钟，请勿重复提交；容器日志会显示安装进度。`
                      : '正在校验并接入应用包，请勿重复提交。'
                  }
                />
              ) : null}
              <Button type="primary" htmlType="submit" block disabled={!pkgFile || previewing || packageSubmitting} loading={packageSubmitting}>
                {packageSubmitting
                  ? pkgPreview?.requirements?.length
                    ? '正在安装依赖并接入…'
                    : '正在校验并接入…'
                  : '校验并接入'}
              </Button>
            </>
          ) : (
            <Button type="primary" htmlType="submit" block>{editing ? '保存（即时生效）' : '接入'}</Button>
          )}
        </Form>
      </Modal>
    </Space>
  );
}

// ---------- 用户与注册（用户列表 + 邀请奖励） ----------

function UsersRegTab(): ReactNode {
  const qc = useQueryClient();
  const { me } = useSession();
  const usersQ = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ users: PublicUser[] }>('/api/admin/users') });
  const invitesQ = useQuery({ queryKey: ['admin-invites'], queryFn: () => api<{ invites: Invite[] }>('/api/admin/invites') });
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);

  async function reload(): Promise<void> {
    void qc.invalidateQueries({ queryKey: ['admin-users'] });
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title="用户列表"
        extra={<Button type="primary" onClick={() => { form.resetFields(); setCreating(true); }}>创建用户</Button>}
      >
        <Table<PublicUser>
          rowKey="id"
          dataSource={usersQ.data?.users ?? []}
          pagination={false}
          size="small"
          columns={[
            { title: '用户名', dataIndex: 'username' },
            { title: '昵称', dataIndex: 'name' },
            { title: '邮箱', dataIndex: 'email', ellipsis: true },
            {
              title: '角色',
              width: 90,
              render: (_, r) => (r.role === 'admin' ? <Tag color="gold">管理员</Tag> : <Tag>用户</Tag>),
            },
            {
              title: '状态',
              width: 90,
              render: (_, r) =>
                r.status === 'active' ? (
                  <Tag color="green">正常</Tag>
                ) : r.status === 'disabled' ? (
                  <Tag color="red">已禁用</Tag>
                ) : r.status === 'pending_approval' ? (
                  <Tag color="orange">待批准</Tag>
                ) : (
                  <Tag>注销中</Tag>
                ),
            },
            {
              title: '操作',
              width: 400,
              render: (_, r) => (
                <Space size={4} wrap>
                  {r.status === 'pending_approval' ? (
                    <Popconfirm
                      title={`批准「${r.name}」？`}
                      description="批准后该 OIDC 账号即可登录。"
                      onConfirm={async () => {
                        await api(`/api/admin/users/${r.id}`, { method: 'PUT', json: { status: 'active' } });
                        message.success('已批准');
                        void reload();
                      }}
                    >
                      <Button size="small" type="primary">批准</Button>
                    </Popconfirm>
                  ) : r.status !== 'disabled' ? (
                    <Popconfirm
                      title={`禁用「${r.username ?? r.name}」？`}
                      description="该用户所有会话将被踢下线。"
                      onConfirm={async () => {
                        await api(`/api/admin/users/${r.id}`, { method: 'PUT', json: { status: 'disabled' } });
                        message.success('已禁用');
                        void reload();
                      }}
                    >
                      <Button size="small" danger>禁用</Button>
                    </Popconfirm>
                  ) : (
                    <Button
                      size="small"
                      onClick={async () => {
                        await api(`/api/admin/users/${r.id}`, { method: 'PUT', json: { status: 'active' } });
                        message.success('已启用');
                        void reload();
                      }}
                    >
                      启用
                    </Button>
                  )}
                  {me?.user.id !== r.id ? (
                    r.role === 'admin' ? (
                      <Popconfirm
                        title={`取消「${r.name}」的管理员？`}
                        description="取消后该用户失去全部后台权限。"
                        onConfirm={async () => {
                          try {
                            await api(`/api/admin/users/${r.id}`, { method: 'PUT', json: { role: 'user' } });
                            message.success('已取消管理员');
                            void reload();
                          } catch (err) {
                            message.error(err instanceof Error ? err.message : '操作失败');
                          }
                        }}
                      >
                        <Button size="small">取消管理员</Button>
                      </Popconfirm>
                    ) : (
                      <Popconfirm
                        title={`将「${r.name}」设为管理员？`}
                        description="管理员拥有全部后台权限。"
                        onConfirm={async () => {
                          try {
                            await api(`/api/admin/users/${r.id}`, { method: 'PUT', json: { role: 'admin' } });
                            message.success('已设为管理员');
                            void reload();
                          } catch (err) {
                            message.error(err instanceof Error ? err.message : '操作失败');
                          }
                        }}
                      >
                        <Button size="small">设为管理员</Button>
                      </Popconfirm>
                    )
                  ) : null}
                  <Button
                    size="small"
                    onClick={async () => {
                      const r2 = await api<{ password: string | null }>(`/api/admin/users/${r.id}/reset-password`, { method: 'POST', json: {} });
                      setCreated({ username: r.username ?? r.name, password: r2.password ?? '' });
                    }}
                  >
                    重置密码
                  </Button>
                  <Popconfirm
                    title={`删除「${r.username}」？`}
                    description="永久删除该用户及其全部数据，不可恢复。"
                    onConfirm={async () => {
                      await api(`/api/admin/users/${r.id}`, { method: 'DELETE' });
                      message.success('已删除');
                      void reload();
                    }}
                  >
                    <Button size="small" danger type="text">删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Alert
        type="info"
        showIcon
        message="本站默认开放注册"
        description="邀请码为选填项；使用有效邀请码注册后，邀请人获得配置的奖励积分。管理员停用邀请码后仍可继续注册，但不发放邀请奖励。"
      />
      <Card size="small" title="注册与邀请奖励">
        <SettingsForm groups={['注册与账号']} excludeKeys={['REGISTRATION_VERIFY_CHANNEL']} />
      </Card>

      <GroupsCard />

      <Card
        size="small"
        title="账号邀请码"
      >
        {invitesQ.isError ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message="邀请码列表加载失败"
            description={invitesQ.error instanceof Error ? invitesQ.error.message : '请稍后重试'}
          />
        ) : null}
        <Table<Invite>
          rowKey="code"
          size="small"
          dataSource={invitesQ.data?.invites ?? []}
          loading={invitesQ.isLoading}
          pagination={{ pageSize: 10, showSizeChanger: true }}
          columns={[
            { title: '邀请码', dataIndex: 'code', render: (v: string) => <Typography.Text copyable code>{v}</Typography.Text> },
            {
              title: '属主账号',
              render: (_, r) => (
                <span title={`用户 ID：${r.ownerUserId}`}>
                  {r.ownerUsername ?? r.ownerEmail ?? r.ownerName}（{r.ownerUserId}）
                </span>
              ),
            },
            { title: '成功注册数', dataIndex: 'useCount', width: 110 },
            {
              title: '邀请奖励',
              width: 130,
              render: (_, r) => (
                <Switch
                  checked={r.enabled}
                  checkedChildren="启用"
                  unCheckedChildren="停用"
                  onChange={async (enabled) => {
                    try {
                      await api(`/api/admin/invites/${encodeURIComponent(r.code)}`, {
                        method: 'PATCH',
                        json: { enabled },
                      });
                      message.success(enabled ? '邀请码已启用' : '邀请码已停用；后续注册不发奖励');
                      void qc.invalidateQueries({ queryKey: ['admin-invites'] });
                    } catch (err) {
                      message.error(err instanceof Error ? err.message : '更新邀请码状态失败');
                    }
                  }}
                />
              ),
            },
            { title: '创建时间', width: 180, render: (_, r) => new Date(r.createdAt).toLocaleString() },
          ]}
        />
      </Card>

      <Modal title="创建用户" open={creating} onCancel={() => setCreating(false)} footer={null} destroyOnClose>
        <Form form={form} layout="vertical" onFinish={async (v) => {
          try {
            const r = await api<{ id: number; initialPassword: string | null }>('/api/admin/users', { method: 'POST', json: v });
            setCreating(false);
            setCreated({ username: v.username, password: r.initialPassword ?? '' });
            void reload();
          } catch (err) {
            message.error(err instanceof Error ? err.message : '创建失败');
          }
        }}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true }, { pattern: /^[a-z0-9][a-z0-9_.-]{2,63}$/, message: '3-64 位小写字母/数字/_.-' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="name" label="昵称">
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色" initialValue="user" extra="管理员拥有全部后台权限（创建后也可在列表中调整）">
            <Select
              options={[
                { value: 'user', label: '用户' },
                { value: 'admin', label: '管理员' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始密码"
            extra="留空自动生成；手动设置需符合 8-128 位且含大写、小写字母和数字；用户首次登录会强制改密"
            rules={[
              {
                validator: (_, value: string | undefined) =>
                  !value || isPasswordValid(value)
                    ? Promise.resolve()
                    : Promise.reject(new Error(PASSWORD_POLICY_MESSAGE)),
              },
            ]}
          >
            <Input.Password placeholder="留空自动生成" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>创建</Button>
        </Form>
      </Modal>

      <Modal
        title="初始密码（仅显示一次）"
        open={Boolean(created)}
        onCancel={() => setCreated(null)}
        footer={<Button type="primary" onClick={() => setCreated(null)}>我已保存</Button>}
      >
        <Descriptions column={1}>
          <Descriptions.Item label="用户名">{created?.username}</Descriptions.Item>
          <Descriptions.Item label="密码">
            <Input readOnly value={created?.password} style={{ fontFamily: 'monospace' }} />
          </Descriptions.Item>
        </Descriptions>
      </Modal>
    </Space>
  );
}

// ---------- 安全（防爆破/PoW/会话/密钥/Turnstile + OIDC + 审计日志） ----------

/** OIDC 回调地址：以当前访问地址自动生成（与 oidc.ts redirectUri 同语义） */
function oidcCallbackUrl(): string {
  return `${window.location.origin}/api/auth/oidc/callback`;
}

function SecurityTab(): ReactNode {
  const qc = useQueryClient();
  const auditQ = useQuery({ queryKey: ['admin-audit'], queryFn: () => api<{ logs: AuditRow[] }>('/api/admin/audit?limit=200') });
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="安全策略">
        <SettingsForm groups={['安全与限流', '人机验证']} />
      </Card>
      <Card size="small" title="OIDC 单点登录">
        <SettingsForm
          groups={['OIDC 单点登录']}
          banners={{
            'OIDC 单点登录': (
              <Alert
                type="info"
                showIcon
                message="在 IdP 登记的重定向 URI（回调地址）——一键复制"
                description={
                  <Space direction="vertical" size={4}>
                    <Typography.Text copyable={{ text: oidcCallbackUrl(), tooltips: ['复制回调地址', '已复制'] }} code>
                      {oidcCallbackUrl()}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      地址按当前访问的站点自动生成；与 Client ID/Secret 同时配置即启用单点登录，修改后需重启服务生效。
                    </Typography.Text>
                  </Space>
                }
              />
            ),
          }}
        />
      </Card>
      <Card
        size="small"
        title="审计日志（最近 200 条）"
        extra={<Button size="small" onClick={() => void qc.invalidateQueries({ queryKey: ['admin-audit'] })}>刷新</Button>}
      >
        <Table<AuditRow>
          rowKey="id"
          size="small"
          dataSource={auditQ.data?.logs ?? []}
          pagination={{ pageSize: 50 }}
          columns={[
            { title: '时间', width: 160, render: (_, r) => new Date(r.ts).toLocaleString() },
            { title: '操作者', dataIndex: 'actor', width: 140, ellipsis: true },
            { title: '事件', dataIndex: 'action', width: 180 },
            { title: 'IP', dataIndex: 'ip', width: 130 },
            {
              title: '明细',
              ellipsis: true,
              render: (_, r) => (
                <Typography.Text code style={{ fontSize: 11 }}>
                  {r.detail ? JSON.stringify(r.detail) : '—'}
                </Typography.Text>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}

// ---------- 通知通道（邮件 [SMTP/Resend] / 阿里云短信） ----------

function MailTab(): ReactNode {
  const qc = useQueryClient();
  const settingsQ = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => api<{ settings: SettingRow[] }>('/api/admin/settings'),
  });
  const [form] = Form.useForm();
  const [smsForm] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [smsSaving, setSmsSaving] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const provider = (Form.useWatch('MAIL_PROVIDER', form) ??
    settingsQ.data?.settings.find((s) => s.key === 'MAIL_PROVIDER')?.value ??
    'smtp') as string;

  const defs = settingsQ.data?.settings ?? [];
  const visibleKeys =
    provider === 'resend'
      ? ['MAIL_PROVIDER', 'RESEND_API_KEY', 'RESEND_FROM']
      : ['MAIL_PROVIDER', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
  const visible = defs.filter((s) => visibleKeys.includes(s.key));
  const smsKeys = [
    'REGISTRATION_VERIFY_CHANNEL',
    'ALIYUN_ACCESS_KEY_ID',
    'ALIYUN_ACCESS_KEY_SECRET',
    'ALIYUN_SMS_SIGN_NAME',
    'ALIYUN_SMS_TEMPLATE_CODE',
    'ALIYUN_SMS_TEMPLATE_PARAM',
    'ALIYUN_SMS_SCHEME_NAME',
  ];
  const smsSettings = defs.filter((s) => smsKeys.includes(s.key));
  const smsChannel = Form.useWatch('REGISTRATION_VERIFY_CHANNEL', smsForm) ??
    defs.find((s) => s.key === 'REGISTRATION_VERIFY_CHANNEL')?.value ?? 'email';

  useEffect(() => {
    if (settingsQ.data) {
      const values: Record<string, string> = {};
      for (const s of defs) values[s.key] = s.value;
      form.setFieldsValue(values);
      smsForm.setFieldsValue(values);
    }
  }, [settingsQ.data, form, smsForm, defs]);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const key of visibleKeys) {
        const v = form.getFieldValue(key);
        if (v !== undefined && v !== null) payload[key] = String(v);
      }
      await api('/api/admin/settings', { method: 'PUT', json: payload });
      message.success('已保存并即时生效');
      void qc.invalidateQueries({ queryKey: ['admin-settings'] });
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function saveSmsSettings(): Promise<void> {
    setSmsSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const key of smsKeys) {
        const value = smsForm.getFieldValue(key);
        if (value !== undefined && value !== null) payload[key] = String(value);
      }
      await api('/api/admin/settings', { method: 'PUT', json: payload });
      message.success('短信配置已保存并即时生效');
      void qc.invalidateQueries({ queryKey: ['admin-settings'] });
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存短信配置失败');
    } finally {
      setSmsSaving(false);
    }
  }

  async function sendTest(): Promise<void> {
    setTesting(true);
    setResult(null);
    try {
      const r = await api<{ to: string }>('/api/admin/mail/test', { method: 'POST', json: { to: testTo || undefined } });
      setResult(`✓ 测试邮件已发送至 ${r.to}，请查收`);
    } catch (err) {
      setResult(`✗ ${err instanceof Error ? err.message : '发送失败'}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="发信通道（验证码用）" extra={<Tag bordered={false} color="blue" style={{ fontSize: 11 }}>Resend 仅需 API Key</Tag>}>
        <Form form={form} layout="vertical">
          <Form.Item
            name="MAIL_PROVIDER"
            label="发信方式"
            tooltip="Resend API：仅需 API Key 即可发信；SMTP 与 Resend 互斥（配置键 MAIL_PROVIDER）"
          >
            <Select
              options={[
                { value: 'smtp', label: 'SMTP 服务器' },
                { value: 'resend', label: 'Resend API' },
              ]}
              style={{ width: 220 }}
            />
          </Form.Item>

          {visible
            .filter((s) => s.key !== 'MAIL_PROVIDER')
            .map((s) => (
              <Form.Item key={s.key} name={s.key} label={s.label} tooltip={s.desc}>
                {renderControl(s, form, true)}
              </Form.Item>
            ))}

          <Button type="primary" loading={saving} onClick={() => void save()}>
            保存（即时生效）
          </Button>
        </Form>
      </Card>

      <Card size="small" title="发信测试">
        <Space wrap>
          <Input
            style={{ width: 260 }}
            placeholder="收件邮箱（留空用管理员邮箱）"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
          />
          <Button type="primary" loading={testing} onClick={() => void sendTest()}>
            发送测试邮件
          </Button>
        </Space>
        {result ? (
          <div style={{ marginTop: 8, fontSize: 12.5 }}>{result}</div>
        ) : (
          <div style={{ marginTop: 8, color: 'var(--aap-text-secondary)', fontSize: 12 }}>
            未配置通道时验证码走服务端日志兜底（内网可离线）。
          </div>
        )}
      </Card>

      <Card size="small" title="手机短信注册（阿里云 Dypnsapi）">
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="短信仅用于新用户注册验证，登录仍使用用户名和密码"
          description="仅支持中国大陆手机号。启用短信注册前，请填写有效的阿里云 AccessKey、已审核签名、模板编码和模板参数；模板参数需为 JSON 对象并包含 ##code##。"
        />
        <Form form={smsForm} layout="vertical">
          {smsSettings.map((s) => (
            <Form.Item key={s.key} name={s.key} label={s.label} tooltip={s.desc}>
              {renderControl(s, smsForm, true)}
            </Form.Item>
          ))}
          <Button type="primary" loading={smsSaving} onClick={() => void saveSmsSettings()}>
            {smsChannel === 'phone' ? '保存并启用短信注册' : '保存短信配置'}
          </Button>
        </Form>
      </Card>
    </Space>
  );
}

// ---------- 证书 ----------

function TlsTab(): ReactNode {
  const qc = useQueryClient();
  const tlsQ = useQuery({
    queryKey: ['admin-tls'],
    queryFn: () =>
      api<{
        installed: boolean;
        httpsEnabled: boolean;
        mode: string;
        domain: string | null;
        email: string | null;
        wildcard: boolean;
        staging: boolean;
        dnsConfigured: boolean;
        httpsPort: number;
        cert: {
          subject: string;
          issuer: string;
          domains: string[];
          validFrom: string;
          validTo: string;
          expired: boolean;
          daysRemaining: number;
          fingerprint: string;
        } | null;
        error?: string;
        acme: {
          inProgress: boolean;
          phase: 'preparing' | 'account' | 'dns' | 'validating' | 'installing' | null;
          lastError: string | null;
          lastSuccessAt: number | null;
        };
      }>('/api/admin/tls'),
    refetchInterval: (query) => (query.state.data?.acme.inProgress ? 1500 : false),
  });
  const [pemForm] = Form.useForm();
  const [acmeForm] = Form.useForm();

  const st = tlsQ.data;
  const isStagingCert = st?.cert?.issuer.includes('(STAGING)') ?? false;
  const phaseItems = [
    { key: 'preparing', title: '准备签发' },
    { key: 'account', title: '连接证书服务' },
    { key: 'dns', title: '创建 DNS 验证记录' },
    { key: 'validating', title: '等待域名验证' },
    { key: 'installing', title: '安装并启用证书' },
  ];
  const phaseIndex = Math.max(0, phaseItems.findIndex((item) => item.key === st?.acme.phase));

  useEffect(() => {
    if (st) {
      acmeForm.setFieldsValue({
        domain: st.domain ?? undefined,
        email: st.email ?? undefined,
      });
    }
  }, [st, acmeForm]);

  return (
    <Space direction="vertical" size="middle" className="aap-tls-page">
      {tlsQ.isError ? <Alert type="error" showIcon message="无法读取证书状态" description={tlsQ.error instanceof Error ? tlsQ.error.message : '请稍后重试'} /> : null}
      <Card className="aap-tls-status" loading={tlsQ.isLoading}>
        <div className="aap-tls-status__heading">
          <div>
            <Typography.Title level={4}>当前证书</Typography.Title>
            <Typography.Text type="secondary">
              {st?.httpsEnabled ? `HTTPS 服务正在使用此证书（端口 ${st.httpsPort}）` : '证书详情及 HTTPS 服务状态'}
            </Typography.Text>
          </div>
          <Space wrap>
            {st?.httpsEnabled ? <Tag color="green">HTTPS 已启用</Tag> : <Tag>HTTPS 未启用</Tag>}
            {st?.acme.inProgress ? <Tag color="processing">签发进行中</Tag> : null}
            {st?.mode === 'acme' && !st.acme.inProgress ? <Tag color="blue">自动续期已启用</Tag> : null}
          </Space>
        </div>
        {st?.cert ? (
          <>
            {isStagingCert ? (
              <Alert
                type="error"
                showIcon
                className="aap-tls-status__alert"
                message="当前是测试证书，浏览器不会信任"
                description="此证书由 Let's Encrypt Staging 颁发。请使用下方 Cloudflare DNS-01 流程重新签发正式证书。"
              />
            ) : st.cert.expired ? (
              <Alert type="error" showIcon className="aap-tls-status__alert" message="当前证书已过期" />
            ) : st.cert.daysRemaining <= 30 ? (
              <Alert type="warning" showIcon className="aap-tls-status__alert" message={`证书将在 ${st.cert.daysRemaining} 天后到期`} />
            ) : null}
            <Descriptions size="small" column={{ xs: 1, sm: 2 }} className="aap-tls-details">
              <Descriptions.Item label="主题">{st.cert.subject}</Descriptions.Item>
              <Descriptions.Item label="颁发者">{st.cert.issuer}</Descriptions.Item>
              <Descriptions.Item label="覆盖域名" span={2}>
                <Space wrap>
                  {st.cert.domains.length
                    ? st.cert.domains.map((domain) => <Tag key={domain}>{domain}</Tag>)
                    : <Typography.Text type="secondary">证书未声明 DNS SAN</Typography.Text>}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="生效时间">{st.cert.validFrom}</Descriptions.Item>
              <Descriptions.Item label="到期时间">
                <Space wrap>
                  <span>{st.cert.validTo}</span>
                  <Tag color={st.cert.expired ? 'red' : st.cert.daysRemaining <= 30 ? 'orange' : 'green'}>
                    {st.cert.expired ? '已过期' : `剩余 ${st.cert.daysRemaining} 天`}
                  </Tag>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="SHA-1 指纹" span={2}>
                <Typography.Text copyable code>{st.cert.fingerprint}</Typography.Text>
              </Descriptions.Item>
            </Descriptions>
          </>
        ) : (
          <Alert
            type={st?.installed ? 'error' : 'info'}
            showIcon
            className="aap-tls-status__alert"
            message={st?.installed ? `证书已安装但无法使用${st.error ? `：${st.error}` : ''}` : '尚未安装证书'}
            description={st?.httpsEnabled ? 'HTTPS 服务状态异常，请检查证书配置。' : '完成 Cloudflare DNS-01 签发后，证书会自动安装并启用 HTTPS。'}
          />
        )}
        {st?.acme.lastSuccessAt ? (
          <Typography.Paragraph type="secondary" className="aap-tls-last-success">
            最近签发成功：{new Date(st.acme.lastSuccessAt).toLocaleString('zh-CN')}
          </Typography.Paragraph>
        ) : null}
        {st?.acme.lastError ? (
          <Alert type="error" showIcon className="aap-tls-status__alert" message="最近一次签发失败" description={st.acme.lastError} />
        ) : null}
      </Card>

      <div className="aap-tls-grid">
        <Card
          className="aap-tls-card"
          title="1. 配置 Cloudflare DNS-01"
          extra={st?.dnsConfigured ? <Tag color="green">已配置</Tag> : <Tag color="orange">待配置</Tag>}
        >
          <Typography.Paragraph type="secondary">
            在 Cloudflare 创建仅对目标 Zone 授予 DNS:Edit 权限的 API Token，并填写 Zone ID。Token 加密保存，不会回显。
          </Typography.Paragraph>
          <SettingsForm
            groups={['证书与 HTTPS']}
            excludeKeys={['ACME_DOMAIN', 'ACME_EMAIL', 'ACME_STAGING', 'ACME_WILDCARD', 'HTTPS_REDIRECT']}
          />
        </Card>

        <Card className="aap-tls-card" title="2. 签发正式通配符证书" extra={<Tag color="blue">Let’s Encrypt 正式环境</Tag>}>
          <Typography.Paragraph type="secondary">
            使用 DNS-01 验证，不依赖公网 80 端口。一次签发同时覆盖根域名和所有一级子域名，并自动续期。
          </Typography.Paragraph>
          {st?.acme.inProgress ? (
            <div className="aap-tls-progress">
              <Steps
                className="aap-tls-progress__steps"
                size="small"
                current={phaseIndex}
                status={st.acme.lastError ? 'error' : 'process'}
                labelPlacement="vertical"
                responsive
                items={phaseItems.map((item) => ({ title: item.title }))}
              />
              <Typography.Text type="secondary">
                {phaseItems[phaseIndex]?.title ?? '正在处理'}，请勿关闭服务；页面会自动更新进度。
              </Typography.Text>
            </div>
          ) : null}
          {st?.acme.lastError ? (
            <Alert type="error" showIcon className="aap-tls-form-alert" message="签发失败" description={st.acme.lastError} />
          ) : null}
          {!st?.dnsConfigured ? (
            <Alert type="warning" showIcon className="aap-tls-form-alert" message="请先完成左侧 Cloudflare 配置并保存" />
          ) : null}
          <Form form={acmeForm} layout="vertical" onFinish={async (v) => {
            try {
              await api('/api/admin/tls/acme', {
                method: 'POST',
                json: { domain: v.domain, email: v.email },
              });
              message.info('正式证书签发已启动，系统将显示实时阶段进度');
              void qc.invalidateQueries({ queryKey: ['admin-tls'] });
            } catch (err) {
              message.error(err instanceof Error ? err.message : '启动失败');
            }
          }}>
            <Form.Item
              name="domain"
              label="根域名"
              extra="例如 example.com；系统会同时申请 example.com 和 *.example.com。"
              rules={[{ required: true, message: '请输入根域名' }]}
            >
              <Input placeholder="example.com" />
            </Form.Item>
            <Form.Item name="email" label="证书通知邮箱" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email' }]}>
              <Input placeholder="you@example.com" />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={st?.acme.inProgress}
              disabled={!st?.dnsConfigured || st?.acme.inProgress}
            >
              {st?.cert ? '重新签发并替换当前证书' : '签发并安装正式证书'}
            </Button>
          </Form>
        </Card>
      </div>

      <Collapse
        items={[{
          key: 'manual',
          label: '高级选项：手动安装 PEM 证书',
          children: (
            <Form form={pemForm} layout="vertical" onFinish={async (v) => {
              try {
                await api('/api/admin/tls', { method: 'PUT', json: v });
                message.success('证书已安装并热生效');
                pemForm.resetFields();
                void qc.invalidateQueries({ queryKey: ['admin-tls'] });
              } catch (err) {
                message.error(err instanceof Error ? err.message : '安装失败');
              }
            }}>
              <Form.Item name="cert" label="证书链 PEM" rules={[{ required: true, message: '请粘贴证书' }]}>
                <Input.TextArea rows={4} placeholder="-----BEGIN CERTIFICATE-----" style={{ fontFamily: 'monospace' }} />
              </Form.Item>
              <Form.Item name="key" label="私钥 PEM" rules={[{ required: true, message: '请粘贴私钥' }]}>
                <Input.TextArea rows={4} placeholder="-----BEGIN PRIVATE KEY-----" style={{ fontFamily: 'monospace' }} />
              </Form.Item>
              <Space wrap>
                <Button type="primary" htmlType="submit">安装并生效</Button>
                <Popconfirm
                  title="移除证书？"
                  description="HTTPS 将立即停用，回到纯门户模式。"
                  onConfirm={async () => {
                    await api('/api/admin/tls', { method: 'DELETE' });
                    message.success('已移除');
                    void qc.invalidateQueries({ queryKey: ['admin-tls'] });
                  }}
                >
                  <Button danger>移除证书</Button>
                </Popconfirm>
              </Space>
            </Form>
          ),
        }]}
      />

      <Card size="small" title="HTTPS 跳转">
        <SettingsForm
          groups={['证书与 HTTPS']}
          excludeKeys={[
            'ACME_DOMAIN',
            'ACME_EMAIL',
            'ACME_STAGING',
            'ACME_WILDCARD',
            'ACME_CLOUDFLARE_ZONE_ID',
            'ACME_CLOUDFLARE_API_TOKEN',
          ]}
        />
      </Card>
    </Space>
  );
}

// ---------- LLM 网关（M2：上游 / 模型路由 / 网关凭据 / 调额 / 用量） ----------

interface LlmUpstream {
  id: number;
  name: string;
  baseUrl: string;
  enabled: boolean;
  hasKey: boolean;
}
interface LlmRoute {
  id: number;
  model: string;
  upstreamId: number;
  upstreamName: string;
  upstreamModel: string;
  multiplier: number;
  priority: number;
  weight: number;
  enabled: boolean;
}
interface LlmToken {
  id: number;
  appId: string;
  name: string;
  enabled: boolean;
  auto: boolean;
  perMinuteLimit: number | null;
  createdAt: string;
  lastUsedAt: string | null;
}
interface LedgerRow {
  id: number;
  ts: number;
  kind: string;
  userId: number | null;
  appId: string | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  delta: number;
  latencyMs: number | null;
  status: string;
}

function LlmTab(): ReactNode {
  const qc = useQueryClient();
  const upstreamsQ = useQuery({ queryKey: ['llm-upstreams'], queryFn: () => api<{ upstreams: LlmUpstream[] }>('/api/admin/llm/upstreams') });
  const routesQ = useQuery({ queryKey: ['llm-routes'], queryFn: () => api<{ routes: LlmRoute[] }>('/api/admin/llm/routes') });
  const tokensQ = useQuery({ queryKey: ['llm-tokens'], queryFn: () => api<{ tokens: LlmToken[] }>('/api/admin/llm/tokens') });
  const usersQ = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ users: PublicUser[] }>('/api/admin/users') });
  const usageQ = useQuery({ queryKey: ['llm-usage'], queryFn: () => api<{ rows: LedgerRow[] }>('/api/admin/llm/usage?limit=50') });

  const [upForm] = Form.useForm();
  const [routeForm] = Form.useForm();
  const [upTest, setUpTest] = useState<Record<number, { loading?: boolean; ok?: boolean; text?: string }>>({});

  async function testUpstream(id: number): Promise<void> {
    setUpTest((p) => ({ ...p, [id]: { loading: true } }));
    try {
      const r = await api<{ ok: boolean; status: number; latencyMs: number; model: string | null; detail: string }>(
        `/api/admin/llm/upstreams/${id}/test`,
        { method: 'POST' },
      );
      setUpTest((p) => ({
        ...p,
        [id]: r.ok
          ? { ok: true, text: `✓ 连通正常（${r.model ?? ''}，${r.latencyMs}ms）` }
          : { ok: false, text: `✗ ${r.status || '网络'}：${r.detail}` },
      }));
    } catch (err) {
      setUpTest((p) => ({ ...p, [id]: { ok: false, text: `✗ ${err instanceof Error ? err.message : '测试失败'}` } }));
    }
  }

  function invalidate(): void {
    for (const k of ['llm-upstreams', 'llm-routes', 'llm-tokens', 'llm-usage']) void qc.invalidateQueries({ queryKey: [k] });
  }

  const upstreamOptions = (upstreamsQ.data?.upstreams ?? []).map((u) => ({ value: u.id, label: `${u.name}（${u.baseUrl}）` }));

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        size="small"
        title="上游（OpenAI 兼容）"
        extra={
          <Button
            size="small"
            type="primary"
            onClick={async () => {
              const v = await upForm.validateFields();
              try {
                await api('/api/admin/llm/upstreams', { method: 'POST', json: v });
                message.success('上游已添加');
                upForm.resetFields();
                invalidate();
              } catch (err) {
                message.error(err instanceof Error ? err.message : '添加失败');
              }
            }}
          >
            添加上游
          </Button>
        }
      >
        <Table<LlmUpstream>
          className="aap-llm-upstreams-table"
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={upstreamsQ.data?.upstreams ?? []}
          columns={[
            { title: '名称', dataIndex: 'name', width: 175 },
            { title: 'Base URL', dataIndex: 'baseUrl', ellipsis: true },
            { title: 'Key', width: 90, render: (_, r) => (r.hasKey ? <Tag color="green">已配置</Tag> : <Tag>无</Tag>) },
            {
              title: '操作',
              width: 220,
              render: (_, r) => (
                <Space size="small" wrap>
                  <Button size="small" onClick={() => void testUpstream(r.id)} loading={upTest[r.id]?.loading}>
                    测试
                  </Button>
                  <Button
                    size="small"
                    onClick={async () => {
                      await api(`/api/admin/llm/upstreams/${r.id}`, { method: 'PUT', json: { enabled: !r.enabled } });
                      invalidate();
                    }}
                  >
                    {r.enabled ? '停用' : '启用'}
                  </Button>
                  <Popconfirm title="删除该上游？其模型路由将一并删除。" onConfirm={async () => {
                    await api(`/api/admin/llm/upstreams/${r.id}`, { method: 'DELETE' });
                    invalidate();
                  }}>
                    <Button size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        {upstreamsQ.data?.upstreams?.filter((u) => upTest[u.id]?.text).map((u) => (
          <div key={u.id} style={{ fontSize: 12, marginTop: 2, color: upTest[u.id]?.ok ? 'var(--ins, #16a34a)' : 'var(--del, #dc2626)' }}>
            {u.name}：{upTest[u.id]?.text}
          </div>
        ))}
        <Form form={upForm} layout="inline" style={{ marginTop: 10, rowGap: 8 }}>
          <Form.Item name="name" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="名称（如 智谱）" style={{ width: 175 }} />
          </Form.Item>
          <Form.Item name="baseUrl" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="https://.../compatible-mode/v1" style={{ width: 300 }} />
          </Form.Item>
          <Form.Item name="apiKey" rules={[{ required: true, message: '必填' }]}>
            <Input.Password placeholder="API Key" style={{ width: 220 }} autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Card>

      <Card size="small" title="模型路由（公开模型名 → 上游模型；同名多条 = failover 候选）">
        <Table<LlmRoute>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={routesQ.data?.routes ?? []}
          columns={[
            { title: '模型名', dataIndex: 'model', width: 150 },
            { title: '上游', dataIndex: 'upstreamName', width: 140 },
            { title: '上游模型', dataIndex: 'upstreamModel', width: 160, ellipsis: true },
            { title: '倍率‰', dataIndex: 'multiplier', width: 80 },
            { title: '优先级', dataIndex: 'priority', width: 80 },
            { title: '权重', dataIndex: 'weight', width: 70 },
            {
              title: '',
              width: 80,
              render: (_, r) => (
                <Popconfirm title="删除该路由？" onConfirm={async () => {
                  await api(`/api/admin/llm/routes/${r.id}`, { method: 'DELETE' });
                  invalidate();
                }}>
                  <Button size="small" danger>删除</Button>
                </Popconfirm>
              ),
            },
          ]}
        />
        <Form form={routeForm} layout="inline" style={{ marginTop: 10, rowGap: 8 }} onFinish={async (v) => {
          try {
            await api('/api/admin/llm/routes', { method: 'POST', json: { ...v, upstreamId: Number(v.upstreamId), multiplier: Number(v.multiplier ?? 100), priority: Number(v.priority ?? 100), weight: Number(v.weight ?? 100) } });
            message.success('路由已添加');
            routeForm.resetFields();
            invalidate();
          } catch (err) {
            message.error(err instanceof Error ? err.message : '添加失败');
          }
        }}>
          <Form.Item name="model" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="公开模型名" style={{ width: 150 }} />
          </Form.Item>
          <Form.Item name="upstreamId" rules={[{ required: true, message: '必选' }]}>
            <Select placeholder="上游" style={{ width: 180 }} options={upstreamOptions} />
          </Form.Item>
          <Form.Item name="upstreamModel" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="上游侧模型名" style={{ width: 170 }} />
          </Form.Item>
          <Form.Item name="multiplier" initialValue={100}>
            <Input placeholder="倍率‰=100" style={{ width: 110 }} />
          </Form.Item>
          <Form.Item name="priority" initialValue={100}>
            <Input placeholder="优先级=100" style={{ width: 110 }} />
          </Form.Item>
          <Form.Item name="weight" initialValue={100}>
            <Input placeholder="权重=100" style={{ width: 100 }} />
          </Form.Item>
          <Button htmlType="submit" type="primary">添加路由</Button>
        </Form>
      </Card>

      <Card
        size="small"
        title="运行时凭据（manifest 声明 llm 的包上传时自动签发，加密保管，运行时注入）"
        extra={<Tag bordered={false} color="blue" style={{ fontSize: 11 }}>自动签发</Tag>}
      >
        <Table<LlmToken>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={tokensQ.data?.tokens ?? []}
          columns={[
            { title: '应用', dataIndex: 'appId', width: 140 },
            { title: '名称', dataIndex: 'name', width: 140, render: (_, r) => (r.auto ? <Space size={4}><Tag color="blue" style={{ fontSize: 11 }}>自动签发</Tag>{r.name}</Space> : r.name) },
            { title: '限流/分', dataIndex: 'perMinuteLimit', width: 90, render: (v: number | null) => v ?? '默认' },
            { title: '状态', width: 90, render: (_, r) => (r.enabled ? <Tag color="green">启用</Tag> : <Tag color="red">已吊销</Tag>) },
            { title: '最近使用', width: 170, render: (_, r) => (r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleString() : '—') },
            {
              title: '',
              width: 90,
              render: (_, r) => (
                <Popconfirm title="吊销该凭据？使用它的应用将立即 401。" onConfirm={async () => {
                  await api(`/api/admin/llm/tokens/${r.id}`, { method: 'DELETE' });
                  invalidate();
                }}>
                  <Button size="small" danger>吊销</Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Card>

      <Card size="small" title="调用账本（最近 50 条）">
        <Table<LedgerRow>
          rowKey="id"
          size="small"
          dataSource={usageQ.data?.rows ?? []}
          pagination={false}
          columns={[
            { title: '时间', width: 160, render: (_, r) => new Date(r.ts).toLocaleString() },
            { title: '类型', dataIndex: 'kind', width: 80 },
            { title: '用户', dataIndex: 'userId', width: 70 },
            { title: '应用', dataIndex: 'appId', width: 110 },
            { title: '模型', dataIndex: 'model', width: 140, ellipsis: true },
            { title: 'tokens', width: 110, render: (_, r) => (r.kind === 'usage' ? `${r.promptTokens ?? 0}+${r.completionTokens ?? 0}` : '—') },
            { title: '变动', dataIndex: 'delta', width: 90, render: (v: number) => <Typography.Text type={v < 0 ? 'danger' : undefined}>{v > 0 ? `+${v}` : v}</Typography.Text> },
            { title: '耗时', dataIndex: 'latencyMs', width: 90, render: (v: number | null) => (v != null ? `${v}ms` : '—') },
          ]}
        />
      </Card>

    </Space>
  );
}

// ---------- 用户分组管理（订阅等级 / 自定义组） ----------

function GroupsCard(): ReactNode {
  const qc = useQueryClient();
  const groupsQ = useQuery({ queryKey: ['admin-groups'], queryFn: () => api<{ groups: GroupRow[] }>('/api/admin/groups') });
  const usersQ = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ users: PublicUser[] }>('/api/admin/users') });
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<GroupRow | null>(null);
  const [editMemberIds, setEditMemberIds] = useState<number[]>([]);
  const [groupModalOpen, setGroupModalOpen] = useState(false);

  const userOptions = (usersQ.data?.users ?? []).map((u) => ({ value: u.id, label: `${u.name}（${u.username ?? u.id}）` }));

  async function reload(): Promise<void> {
    void qc.invalidateQueries({ queryKey: ['admin-groups'] });
  }

  return (
    <Card
      size="small"
      title="用户分组（订阅等级 / 自定义组）"
      extra={
        <Button
          size="small"
          type="primary"
          onClick={() => {
            setEditing(null);
            setEditMemberIds([]);
            form.setFieldsValue({ name: '', note: '', appPublishRewardPoints: 0 });
            setGroupModalOpen(true);
          }}
        >
          新建分组
        </Button>
      }
    >
      <Table<GroupRow>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={groupsQ.data?.groups ?? []}
        columns={[
          { title: '分组', dataIndex: 'name', width: 180 },
          { title: '备注', dataIndex: 'note', ellipsis: true },
          {
            title: '公开发布奖励',
            dataIndex: 'appPublishRewardPoints',
            width: 130,
            render: (points: number) => `${points} 分/个`,
          },
          { title: '成员数', dataIndex: 'memberCount', width: 90 },
          {
            title: '操作',
            width: 160,
            render: (_, r) => (
              <Space size="small">
                <Button
                  size="small"
                  onClick={async () => {
                    const res = await api<{ memberIds: number[] }>(`/api/admin/groups/${r.id}/members`);
                    setEditMemberIds(res.memberIds);
                    form.setFieldsValue({
                      name: r.name,
                      note: r.note,
                      appPublishRewardPoints: r.appPublishRewardPoints,
                    });
                    setEditing(r);
                    setGroupModalOpen(true);
                  }}
                >
                  设置
                </Button>
                <Popconfirm title="删除分组？该组成员将不再归属此分组。" onConfirm={async () => {
                  await api(`/api/admin/groups/${r.id}`, { method: 'DELETE' });
                  void reload();
                }}>
                  <Button size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? `设置分组：${editing.name}` : '新建分组'}
        open={groupModalOpen}
        onCancel={() => setGroupModalOpen(false)}
        onOk={async () => {
          try {
            const values = await form.validateFields();
            if (editing) {
              await api(`/api/admin/groups/${editing.id}`, {
                method: 'PUT',
                json: { ...values, memberIds: editMemberIds },
              });
              message.success('分组设置已保存');
            } else {
              await api('/api/admin/groups', { method: 'POST', json: values });
              message.success('分组已创建');
            }
            setGroupModalOpen(false);
            void reload();
          } catch (err) {
            if (err instanceof Error) message.error(err.message);
          }
        }}
        okText={editing ? '保存设置' : '创建分组'}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="分组名称"
            rules={[{ required: true, whitespace: true, message: '请输入分组名称' }]}
          >
            <Input maxLength={64} placeholder="例如：订阅-高级" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea maxLength={200} rows={2} placeholder="可选，简要说明分组用途" />
          </Form.Item>
          <Form.Item
            name="appPublishRewardPoints"
            label="公开发布应用奖励"
            tooltip="该组用户首次将自己创建的应用设为公开时获得的积分；删除已获奖励的应用会扣回，余额最低为 0。"
            rules={[{ required: true, message: '请输入积分奖励基准' }]}
          >
            <InputNumber min={0} max={2_147_483_647} precision={0} addonAfter="分/个" style={{ width: '100%' }} />
          </Form.Item>
          {editing && (
            <Form.Item label="分组成员">
              <Select
                mode="multiple"
                style={{ width: '100%' }}
                placeholder="选择该分组的成员"
                value={editMemberIds}
                onChange={(v) => setEditMemberIds(v as number[])}
                options={userOptions}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Card>
  );
}

// ---------- 运营面板（M3，D4）：套餐 / 订单 / 排行 / 成本毛利 ----------

interface PlanRowUI {
  id: number;
  name: string;
  groupId: number;
  groupName: string;
  durationDays: number;
  priceCurrency: 'CNY' | 'USD' | 'POINTS';
  priceFen: number;
  priceCents: number;
  pricePoints: number;
  redeemUrl: string | null;
  tokenGrant: number;
  tier: number;
  appUploadLimit: number;
  appCloneLimit: number;
  enabled: boolean;
}
interface OrderRowUI {
  id: string;
  userId: number;
  kind: 'tokens' | 'membership';
  planId: number | null;
  tokens: number | null;
  priceCurrency: 'CNY' | 'USD';
  priceFen: number;
  priceCents: number;
  channel: string;
  status: 'pending' | 'paid' | 'cancelled';
  note: string | null;
  createdAt: number;
  paidAt: number | null;
}
interface OpsStatsUI {
  balanceTop: Array<{ userId: number; balance: number }>;
  spentTop: Array<{ userId: number; spent: number }>;
  appHot: Array<{ appId: string; calls: number; tokens: number }>;
  revenue30d: number;
  cost30d: number;
}

const PLAN_DURATION_DAYS: Record<string, number> = { month: 30, quarter: 90, year: 365 };

function planDurationLabel(days: number): string {
  if (days === 30) return '月（30 天）';
  if (days === 90) return '季度（90 天）';
  if (days === 365) return '年（365 天）';
  return days >= 100_000 ? '长期' : `${days} 天`;
}

function planDurationUnit(days: number): string {
  if (days === 90) return 'quarter';
  if (days === 365) return 'year';
  return 'month';
}

function OpsTab(): ReactNode {
  const qc = useQueryClient();
  const usersQ = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ users: PublicUser[] }>('/api/admin/users') });
  const [adjustForm] = Form.useForm();
  const plansQ = useQuery({ queryKey: ['billing-plans'], queryFn: () => api<{ plans: PlanRowUI[] }>('/api/admin/billing/plans') });
  const ordersQ = useQuery({ queryKey: ['billing-orders'], queryFn: () => api<{ orders: OrderRowUI[] }>('/api/admin/billing/orders?status=pending') });
  const opsQ = useQuery({ queryKey: ['billing-ops'], queryFn: () => api<OpsStatsUI>('/api/admin/billing/ops') });
  const groupsQ = useQuery({ queryKey: ['admin-groups'], queryFn: () => api<{ groups: GroupRow[] }>('/api/admin/groups') });
  const [planForm] = Form.useForm();
  const priceCurrency = Form.useWatch('priceCurrency', planForm) as PlanRowUI['priceCurrency'] | undefined;
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [planSaving, setPlanSaving] = useState(false);
  const [editingPlan, setEditingPlan] = useState<PlanRowUI | null>(null);

  const ops = opsQ.data;
  const grossMargin = ops ? ops.revenue30d - ops.cost30d : 0;
  const openCreatePlan = () => {
    setEditingPlan(null);
    planForm.resetFields();
    planForm.setFieldsValue({
      durationUnit: 'month',
      tier: 0,
      appUploadLimit: 10,
      appCloneLimit: 0,
      tokenGrant: 0,
      priceCurrency: 'CNY',
      priceAmount: 0,
    });
    setPlanModalOpen(true);
  };
  const openEditPlan = (plan: PlanRowUI) => {
    setEditingPlan(plan);
    planForm.resetFields();
    planForm.setFieldsValue({
      name: plan.name,
      groupId: plan.groupId,
      tier: plan.tier,
      durationUnit: planDurationUnit(plan.durationDays),
      appUploadLimit: plan.appUploadLimit,
      appCloneLimit: plan.appCloneLimit,
      tokenGrant: plan.tokenGrant,
      priceCurrency: plan.priceCurrency,
      priceAmount:
        plan.priceCurrency === 'CNY'
          ? plan.priceFen / 100
          : plan.priceCurrency === 'USD'
            ? plan.priceCents / 100
            : plan.pricePoints,
      redeemUrl: plan.redeemUrl ?? '',
    });
    setPlanModalOpen(true);
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <Card size="small" title="30 天收入（额度）">
          <Typography.Text strong style={{ fontSize: 22 }}>{ops?.revenue30d.toLocaleString() ?? '—'}</Typography.Text>
        </Card>
        <Card size="small" title="30 天上游成本">
          <Typography.Text strong style={{ fontSize: 22 }}>{ops?.cost30d.toLocaleString() ?? '—'}</Typography.Text>
        </Card>
        <Card size="small" title="毛利（额度）">
          <Typography.Text strong style={{ fontSize: 22, color: grossMargin >= 0 ? '#2E7D32' : '#ff4d4f' }}>
            {grossMargin.toLocaleString()}
          </Typography.Text>
        </Card>
        <Card size="small" title="待处理订单">
          <Typography.Text strong style={{ fontSize: 22 }}>{ordersQ.data?.orders.length ?? 0}</Typography.Text>
        </Card>
      </div>

      <Card size="small" title="功能订阅套餐" extra={<Button type="primary" onClick={openCreatePlan}>创建套餐</Button>}>
        <Table<PlanRowUI>
          rowKey="id"
          size="small"
          pagination={false}
          scroll={{ x: 1080 }}
          dataSource={plansQ.data?.plans ?? []}
          columns={[
            { title: '计划名称', dataIndex: 'name', width: 150 },
            { title: '权益等级', dataIndex: 'tier', width: 120, render: (tier: number) => <TierBadge tier={tier} /> },
            { title: '分组', dataIndex: 'groupName', width: 140 },
            { title: '可用时间', dataIndex: 'durationDays', width: 130, render: (v: number) => planDurationLabel(v) },
            { title: '可创建应用', dataIndex: 'appUploadLimit', width: 150, render: (v: number) => formatEntitlementCount(v) },
            { title: '可克隆应用数', dataIndex: 'appCloneLimit', width: 150, render: (v: number) => formatEntitlementCount(v) },
            { title: 'Token 额度', dataIndex: 'tokenGrant', width: 120, render: (v: number) => formatEntitlementCount(v) },
            { title: '价格', width: 120, render: (_, r) => formatMembershipPlanPrice(r) },
            { title: '状态', width: 80, render: (_, r) => (r.enabled ? <Tag color="green">在售</Tag> : <Tag>停售</Tag>) },
            {
              title: '操作',
              width: 240,
              render: (_, r) => (
                <Space size="small" wrap>
                  <Button size="small" onClick={() => openEditPlan(r)}>编辑</Button>
                  <Button size="small" onClick={async () => {
                    await api(`/api/admin/billing/plans/${r.id}`, { method: 'PUT', json: { enabled: !r.enabled } });
                    void qc.invalidateQueries({ queryKey: ['billing-plans'] });
                  }}>{r.enabled ? '停售' : '在售'}</Button>
                  <Popconfirm title="删除套餐？" onConfirm={async () => {
                    try {
                      await api(`/api/admin/billing/plans/${r.id}`, { method: 'DELETE' });
                      void qc.invalidateQueries({ queryKey: ['billing-plans'] });
                    } catch (err) {
                      message.error(err instanceof Error ? err.message : '删除失败');
                    }
                  }}>
                    <Button size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={editingPlan ? `编辑功能订阅套餐：${editingPlan.name}` : '创建功能订阅套餐'}
        open={planModalOpen}
        confirmLoading={planSaving}
        okText={editingPlan ? '保存修改' : '创建套餐'}
        cancelText="取消"
        onCancel={() => {
          setPlanModalOpen(false);
          setEditingPlan(null);
          planForm.resetFields();
        }}
        onOk={() => planForm.submit()}
        destroyOnClose
        width={600}
      >
        {editingPlan ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="修改范围与生效方式"
            description="可创建/克隆应用数量修改后会立即影响该计划的所有有效订阅者；已创建的应用不会被删除，但额度低于已用数量时将不能继续创建。Token 赠额、价格和有效期仅用于之后开通或续订，不会改变现有余额或当前到期时间。权益分组暂不支持修改。"
          />
        ) : null}
        <Form
          form={planForm}
          layout="vertical"
          initialValues={{ durationUnit: 'month', tier: 0, appUploadLimit: 10, appCloneLimit: 0, tokenGrant: 0, priceCurrency: 'CNY', priceAmount: 0 }}
          onFinish={async (values) => {
            setPlanSaving(true);
            try {
              const payload = {
                name: values.name,
                durationDays: PLAN_DURATION_DAYS[String(values.durationUnit)],
                tier: Number(values.tier),
                appUploadLimit: Number(values.appUploadLimit),
                appCloneLimit: Number(values.appCloneLimit ?? 0),
                tokenGrant: Number(values.tokenGrant ?? 0),
                priceCurrency: values.priceCurrency,
                priceFen: values.priceCurrency === 'CNY' ? Math.round(Number(values.priceAmount ?? 0) * 100) : 0,
                priceCents: values.priceCurrency === 'USD' ? Math.round(Number(values.priceAmount ?? 0) * 100) : 0,
                pricePoints: values.priceCurrency === 'POINTS' ? Number(values.priceAmount ?? 0) : 0,
                redeemUrl: values.redeemUrl?.trim() || null,
              };
              await api(
                editingPlan ? `/api/admin/billing/plans/${editingPlan.id}` : '/api/admin/billing/plans',
                {
                  method: editingPlan ? 'PUT' : 'POST',
                  json: {
                    ...payload,
                    ...(editingPlan ? {} : { groupId: Number(values.groupId) }),
                  },
                },
              );
              message.success(editingPlan ? '套餐已更新' : '套餐已创建');
              setPlanModalOpen(false);
              setEditingPlan(null);
              planForm.resetFields();
              void qc.invalidateQueries({ queryKey: ['billing-plans'] });
            } catch (err) {
              message.error(err instanceof Error ? err.message : editingPlan ? '更新失败' : '创建失败');
            } finally {
              setPlanSaving(false);
            }
          }}
        >
          <Form.Item name="name" label="计划名称" rules={[{ required: true, message: '请填写计划名称' }]}>
            <Input maxLength={64} placeholder="例如：专业版" />
          </Form.Item>
          <Form.Item
            name="groupId"
            label="分组"
            rules={editingPlan ? undefined : [{ required: true, message: '请选择分组' }]}
            extra={editingPlan ? '套餐关联分组决定应用访问权限，编辑时不可更换。' : undefined}
          >
            <Select
              disabled={editingPlan !== null}
              placeholder="选择订阅权益分组"
              options={groupsQ.data?.groups.map((group) => ({ value: group.id, label: group.name }))}
            />
          </Form.Item>
          <Form.Item name="tier" label="权益等级" rules={[{ required: true, message: '请选择权益等级' }]}>
            <Select
              options={Array.from({ length: 6 }, (_, tier) => ({
                value: tier,
                label: <Space size={8}><TierBadge tier={tier} size={20} /></Space>,
              }))}
            />
          </Form.Item>
          <Form.Item name="durationUnit" label="可用时间" rules={[{ required: true }]}>
            <Select options={[{ value: 'month', label: '月（30 天）' }, { value: 'quarter', label: '季度（90 天）' }, { value: 'year', label: '年（365 天）' }]} />
          </Form.Item>
          <Form.Item name="appUploadLimit" label="可创建应用" rules={[{ required: true, message: '请设置可创建应用数量' }]}>
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="appCloneLimit" label="可克隆应用数量" rules={[{ required: true, message: '请设置可克隆应用数量' }]}>
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="tokenGrant" label="Token 额度">
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="priceCurrency" label="计价单位" rules={[{ required: true }]}>
            <Select options={[
              { value: 'CNY', label: '人民币' },
              { value: 'USD', label: '美元' },
              { value: 'POINTS', label: '积分' },
            ]} />
          </Form.Item>
          <Form.Item
            name="priceAmount"
            label={`价格（${priceCurrency === 'USD' ? '美元' : priceCurrency === 'POINTS' ? '积分' : '人民币'}）`}
            rules={[{ required: true, message: '请填写价格' }]}
          >
            <InputNumber
              min={0}
              max={priceCurrency === 'POINTS' ? 2_147_483_647 : 21_474_836.47}
              precision={priceCurrency === 'POINTS' ? 0 : 2}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item
            name="redeemUrl"
            label="兑换码链接"
            rules={[{
              validator: async (_, value?: string) => {
                if (!value?.trim()) return;
                let url: URL;
                try {
                  url = new URL(value.trim());
                } catch {
                  throw new Error('请输入有效的 http 或 https 链接');
                }
                if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
                  throw new Error('请输入有效的 http 或 https 链接');
                }
              },
            }]}
          >
            <Input maxLength={2048} placeholder="https://example.com/redeem（选填）" />
          </Form.Item>
        </Form>
      </Modal>

      <Card size="small" title="待确认订单（人工确认到账；确认后权益/额度自动生效）">
        <Table<OrderRowUI>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={ordersQ.data?.orders ?? []}
          columns={[
            { title: '订单号', dataIndex: 'id', width: 170 },
            { title: '用户', dataIndex: 'userId', width: 70 },
            { title: '类型', width: 90, render: (_, r) => (r.kind === 'membership' ? '订阅' : '额度') },
            { title: '金额', width: 110, render: (_, r) => formatMembershipOrderPrice(r) },
            { title: '到账', width: 110, render: (_, r) => (r.kind === 'tokens' ? `${r.tokens?.toLocaleString()} 额度` : '订阅权益') },
            { title: '创建时间', width: 160, render: (_, r) => new Date(r.createdAt).toLocaleString() },
            {
              title: '操作',
              width: 160,
              render: (_, r) => (
                <Space size="small">
                  <Popconfirm title={`确认已收到 ${formatMembershipOrderPrice(r)}？确认后立即生效。`} onConfirm={async () => {
                    await api(`/api/admin/billing/orders/${r.id}/confirm`, { method: 'POST' });
                    message.success('已确认到账');
                    void qc.invalidateQueries({ queryKey: ['billing-orders'] });
                    void qc.invalidateQueries({ queryKey: ['billing-ops'] });
                  }}>
                    <Button size="small" type="primary">确认到账</Button>
                  </Popconfirm>
                  <Button size="small" onClick={async () => {
                    await api(`/api/admin/billing/orders/${r.id}/cancel`, { method: 'POST' });
                    void qc.invalidateQueries({ queryKey: ['billing-orders'] });
                  }}>取消</Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <RedeemCard />

      <Card size="small" title="用户额度发放 / 调减">
        <Form layout="inline" form={adjustForm} onFinish={async (v) => {
          try {
            const r = await api<{ balance: number }>('/api/admin/llm/adjust', {
              method: 'POST',
              json: { userId: Number(v.userId), delta: Number(v.delta), note: v.note },
            });
            message.success(`已调整，当前余额 ${r.balance}`);
            adjustForm.resetFields();
            void qc.invalidateQueries({ queryKey: ['billing-ops'] });
            void qc.invalidateQueries({ queryKey: ['llm-usage'] });
          } catch (err) {
            message.error(err instanceof Error ? err.message : '调整失败');
          }
        }}>
          <Form.Item name="userId" rules={[{ required: true, message: '必选' }]}>
            <Select
              placeholder="选择用户"
              style={{ width: 180 }}
              showSearch
              optionFilterProp="label"
              options={(usersQ.data?.users ?? []).map((u) => ({ value: u.id, label: `${u.name}（${u.username ?? u.id}）` }))}
            />
          </Form.Item>
          <Form.Item name="delta" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="变动量（±token）" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="note">
            <Input placeholder="备注" style={{ width: 180 }} />
          </Form.Item>
          <Button htmlType="submit" type="primary">确认调整</Button>
        </Form>
      </Card>


      <Card size="small" title="计费设置">
        <SettingsForm groups={['计费']} />
      </Card>


      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
        <Card size="small" title="余额排行">
          {(ops?.balanceTop ?? []).map((r, i) => (
            <div key={r.userId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '2px 0' }}>
              <span>#{i + 1} 用户 {r.userId}</span>
              <Typography.Text strong>{r.balance.toLocaleString()}</Typography.Text>
            </div>
          ))}
        </Card>
        <Card size="small" title="消耗排行（30 天）">
          {(ops?.spentTop ?? []).map((r, i) => (
            <div key={r.userId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '2px 0' }}>
              <span>#{i + 1} 用户 {r.userId}</span>
              <Typography.Text type="danger">-{r.spent.toLocaleString()}</Typography.Text>
            </div>
          ))}
        </Card>
        <Card size="small" title="应用热度（30 天）">
          {(ops?.appHot ?? []).map((r) => (
            <div key={r.appId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '2px 0' }}>
              <span>{r.appId}</span>
              <span style={{ color: 'var(--aap-text-secondary)' }}>{r.calls} 次 / {r.tokens.toLocaleString()} tokens</span>
            </div>
          ))}
        </Card>
      </div>
    </Space>
  );
}

// ---------- 卡券码（充值码/订阅码批量生成与兑换管理） ----------

interface RedeemBatch {
  batchId: string;
  kind: 'tokens' | 'membership';
  total: number;
  used: number;
  tokens: number | null;
  planId: number | null;
  note: string | null;
  expiresAt: number | null;
  createdAt: number;
}
interface RedeemCodeRowUI {
  code: string;
  kind: string;
  tokens: number | null;
  status: 'unused' | 'used' | 'disabled';
  usedBy: number | null;
  expiresAt: number | null;
}

function RedeemCard(): ReactNode {
  const qc = useQueryClient();
  const batchesQ = useQuery({ queryKey: ['redeem-batches'], queryFn: () => api<{ batches: RedeemBatch[] }>('/api/admin/redeem/batches') });
  const plansQ = useQuery({ queryKey: ['billing-plans'], queryFn: () => api<{ plans: PlanRowUI[] }>('/api/admin/billing/plans') });
  const [form] = Form.useForm();
  const [kind, setKind] = useState<'tokens' | 'membership'>('tokens');
  const [generated, setGenerated] = useState<string[] | null>(null);
  const [viewBatch, setViewBatch] = useState<string>('');

  const codesQ = useQuery({
    queryKey: ['redeem-codes', viewBatch],
    queryFn: () => api<{ codes: RedeemCodeRowUI[] }>(`/api/admin/redeem/codes?limit=200${viewBatch ? `&batchId=${viewBatch}` : ''}`),
  });

  function invalidate(): void {
    void qc.invalidateQueries({ queryKey: ['redeem-batches'] });
    void qc.invalidateQueries({ queryKey: ['redeem-codes'] });
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="生成卡券码（额度码 / 订阅码）">
        <Form form={form} layout="inline" style={{ rowGap: 8 }} onFinish={async (v) => {
          try {
            const r = await api<{ batchId: string; codes: string[] }>('/api/admin/redeem/batches', {
              method: 'POST',
              json: {
                kind,
                count: Number(v.count),
                tokens: kind === 'tokens' ? Number(v.tokens) : undefined,
                planId: kind === 'membership' ? Number(v.planId) : undefined,
                expiresInDays: v.expiresInDays ? Number(v.expiresInDays) : null,
                note: v.note || undefined,
              },
            });
            setGenerated(r.codes);
            invalidate();
          } catch (err) {
            message.error(err instanceof Error ? err.message : '生成失败');
          }
        }}>
          <Form.Item name="kind" initialValue="tokens" rules={[{ required: true }]}>
            <Select
              style={{ width: 120 }}
              onChange={(v) => setKind(v as 'tokens' | 'membership')}
              options={[
                { value: 'tokens', label: '额度码' },
                { value: 'membership', label: '订阅码' },
              ]}
            />
          </Form.Item>
          {kind === 'tokens' ? (
            <Form.Item name="tokens" rules={[{ required: true, message: '必填' }]}>
              <Input placeholder="每张面额(token)" style={{ width: 150 }} />
            </Form.Item>
          ) : (
            <Form.Item name="planId" rules={[{ required: true, message: '必选' }]}>
              <Select
                placeholder="绑定套餐"
                style={{ width: 170 }}
                options={(plansQ.data?.plans ?? []).map((p) => ({ value: p.id, label: `${p.name}（${p.durationDays}天）` }))}
              />
            </Form.Item>
          )}
          <Form.Item name="count" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="数量=10" style={{ width: 100 }} />
          </Form.Item>
          <Form.Item name="expiresInDays">
            <Input placeholder="有效天数(可选)" style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="note">
            <Input placeholder="备注" style={{ width: 140 }} />
          </Form.Item>
          <Button htmlType="submit" type="primary">生成</Button>
        </Form>

        {generated ? (
          <div style={{ marginTop: 10 }}>
            <Space style={{ marginBottom: 6 }}>
              <Button
                size="small"
                type="primary"
                icon={<CopyOutlined />}
                onClick={async () => {
                  await navigator.clipboard.writeText(generated.join('\n'));
                  message.success(`已复制 ${generated.length} 个码`);
                }}
              >
                复制全部（{generated.length} 个）
              </Button>
              <Typography.Text type="secondary">每行一个码，仅本次展示（可随时按批次查询）</Typography.Text>
            </Space>
            <Input.TextArea rows={Math.min(8, generated.length)} readOnly value={generated.join('\n')} style={{ fontFamily: 'monospace', fontSize: 12 }} />
          </div>
        ) : null}
      </Card>

      <Card
        size="small"
        title="批次与码查询"
        extra={
          <Button size="small" onClick={() => { invalidate(); }}>刷新</Button>
        }
      >
        <Table<RedeemBatch>
          rowKey="batchId"
          size="small"
          pagination={false}
          dataSource={batchesQ.data?.batches ?? []}
          columns={[
            { title: '批次', dataIndex: 'batchId', width: 110 },
            { title: '类型', width: 90, render: (_, r) => (r.kind === 'tokens' ? '额度码' : '订阅码') },
            { title: '面额/套餐', width: 130, render: (_, r) => (r.kind === 'tokens' ? `${r.tokens?.toLocaleString()} 额度` : `套餐 #${r.planId}`) },
            { title: '用量', width: 110, render: (_, r) => `${r.used}/${r.total}` },
            { title: '备注', dataIndex: 'note', ellipsis: true },
            {
              title: '',
              width: 110,
              render: (_, r) => (
                <Button size="small" onClick={() => setViewBatch(r.batchId)}>查看码</Button>
              ),
            },
          ]}
        />
        {viewBatch ? (
          <div style={{ marginTop: 10 }}>
            <Typography.Text type="secondary">批次 {viewBatch}：</Typography.Text>
            <Table<RedeemCodeRowUI>
              rowKey="code"
              size="small"
              pagination={false}
              dataSource={(codesQ.data?.codes ?? []).filter((c) => c.status !== 'disabled')}
              columns={[
                { title: '码', dataIndex: 'code', render: (v: string) => <Typography.Text copyable code>{v}</Typography.Text> },
                { title: '状态', width: 100, render: (_, r) => (r.status === 'unused' ? <Tag color="green">未用</Tag> : r.status === 'used' ? <Tag>已用</Tag> : <Tag color="red">作废</Tag>) },
                { title: '使用者', dataIndex: 'usedBy', width: 90 },
                {
                  title: '',
                  width: 90,
                  render: (_, r) =>
                    r.status === 'unused' ? (
                      <Popconfirm title="作废该码？" onConfirm={async () => {
                        await api('/api/admin/redeem/disable', { method: 'POST', json: { code: r.code } });
                        invalidate();
                      }}>
                        <Button size="small" danger>作废</Button>
                      </Popconfirm>
                    ) : null,
                },
              ]}
            />
          </div>
        ) : null}
      </Card>
    </Space>
  );
}
