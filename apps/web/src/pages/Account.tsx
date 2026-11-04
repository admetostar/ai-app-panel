/**
 * 用户中心：资料、安全、应用管理、权益查看与获取。
 * 敏感操作（换绑邮箱、注销、MFA 管理）前置步升认证：重输密码或 TOTP。
 */
import { withBase } from '../lib/base';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, SettingOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { obtainPowToken } from '../lib/pow';
import { useSession } from '../state/session';
import { useStepUp, withStepUp } from '../components/StepUpModal';
import { registerNewPasskey } from '../lib/mfaClient';
import { AppSettingsModal } from '../components/AppSettingsModal';
import { TierBadge } from '../components/TierBadge';
import type { MembershipOrderSummary, MembershipPlanSummary, OwnedAppCard, PortalBootstrap, UserMembershipData } from '@aap/shared';
import { isPasswordValid, PASSWORD_POLICY_MESSAGE } from '@aap/shared';
import { formatEntitlementCount, formatMembershipOrderPrice, formatMembershipPlanPrice, isFreeMembershipPlan } from '../lib/membershipPricing';
import { downloadInviteIdentityCard } from '../lib/inviteIdentityCard';
import { bytesToBase64 } from '../lib/base64';

// ---------- 主页面 ----------

interface SessionRow {
  id: string;
  current: boolean;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
}

const ACCOUNT_TABS = ['myapps', 'profile', 'security', 'benefits', 'plans'] as const;
type AccountTabKey = (typeof ACCOUNT_TABS)[number];

export function AccountPage() {
  const { activeUserPageTheme } = useOutletContext<{ activeUserPageTheme: 'light' | 'dark' }>();
  const { me, refetch } = useSession();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const [stepUpModal, ensureStepUp] = useStepUp(activeUserPageTheme);
  const [profileForm] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [exportingInviteCard, setExportingInviteCard] = useState(false);
  const [emailModal, setEmailModal] = useState(false);
  const [emailForm] = Form.useForm();
  const [emailCooldown, setEmailCooldown] = useState(0);
  const [deleteModal, setDeleteModal] = useState(false);
  const [deleteForm] = Form.useForm();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sendingEmailCode, setSendingEmailCode] = useState(false);
  const [emailSending, setEmailSending] = useState(false);

  const user = me?.user;
  const requestedTab = searchParams.get('tab');
  const accountTab: AccountTabKey = requestedTab === 'billing'
    ? 'benefits'
    : ACCOUNT_TABS.find((tab) => tab === requestedTab) ?? ACCOUNT_TABS[0];
  const sectionDetails: Record<AccountTabKey, { group: string; title: string; description: string }> = {
    myapps: {
      group: '应用',
      title: '应用管理',
      description: '上传、管理和发布你创建的应用，并维护运行所需的环境变量。',
    },
    profile: {
      group: '账户和安全',
      title: '账户信息',
      description: '查看和更新个人资料、登录邮箱及账户状态。',
    },
    security: {
      group: '账户和安全',
      title: '安全管理',
      description: '管理密码、多因子认证和已登录设备，保护你的账户安全。',
    },
    benefits: {
      group: '权益中心',
      title: '我的权益',
      description: '查看权益有效期、应用上传名额、Token 额度与积分；首次将应用设为公开可按所属分组获积分，删除时扣回（余额最低为 0）。',
    },
    plans: {
      group: '权益中心',
      title: '获取权益',
      description: '可用积分兑换符合条件的权益包，也可通过兑换码获取指定订阅或 Token 额度；其他方案按页面说明获取。',
    },
  };

  useEffect(() => {
    if (user) profileForm.setFieldsValue({ name: user.name });
  }, [user, profileForm]);

  async function loadSessions(): Promise<void> {
    try {
      const r = await api<{ sessions: SessionRow[] }>('/api/user/sessions');
      setSessions(r.sessions);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    if (me && accountTab === 'security') void loadSessions();
  }, [me, accountTab]);

  useEffect(() => {
    if (emailCooldown <= 0) return;
    const timer = window.setTimeout(() => setEmailCooldown((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [emailCooldown]);

  if (!me || !user) {
    return <Alert type="info" showIcon message="请先登录" description={<a href={withBase('/login')}>去登录</a>} />;
  }

  async function saveProfile(values: { name: string }): Promise<void> {
    setSaving(true);
    try {
      await api('/api/user/profile', { method: 'PATCH', json: values });
      message.success('已保存');
      void refetch();
      void qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function exportInviteCard(): Promise<void> {
    if (!user) {
      message.error('请先登录后再导出邀请电子卡');
      return;
    }
    setExportingInviteCard(true);
    try {
      const [invite, bootstrap] = await Promise.all([
        qc.fetchQuery({
          queryKey: ['user-invite'],
          queryFn: () => api<{ code: string; useCount: number }>('/api/user/invite'),
          staleTime: 30_000,
        }),
        qc.fetchQuery({
          queryKey: ['bootstrap'],
          queryFn: () => api<PortalBootstrap>('/api/portal/bootstrap'),
          staleTime: 30_000,
        }),
      ]);
      await downloadInviteIdentityCard({
        siteName: bootstrap.branding.siteName || 'ai-app-panel',
        logo: bootstrap.branding.logo,
        userName: user.name,
        code: invite.code,
        useCount: invite.useCount,
        theme: activeUserPageTheme,
      });
      message.success('邀请电子卡 PNG 已导出');
    } catch (error) {
      message.error(error instanceof Error ? `导出失败：${error.message}` : '导出失败，请稍后重试');
    } finally {
      setExportingInviteCard(false);
    }
  }

  async function changePassword(values: { currentPassword: string; newPassword: string }): Promise<void> {
    try {
      await api('/api/auth/change-password', { method: 'POST', json: values });
      message.success('密码已修改，其他设备已退出登录');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '修改失败');
    }
  }

  async function sendEmailCode(): Promise<void> {
    setSendingEmailCode(true);
    try {
      const { newEmail } = await emailForm.validateFields(['newEmail']);
      const powToken = await obtainPowToken();
      const r = await api<{ sentTo: string; viaLogFallback: boolean; resendAfterMs: number }>('/api/user/email/change/start', {
        method: 'POST',
        json: { newEmail, powToken },
      });
      message.success(r.viaLogFallback ? '验证码在服务端日志中' : `验证码已发送至 ${r.sentTo}`);
      setEmailCooldown(Math.ceil(r.resendAfterMs / 1000));
    } catch (err) {
      message.error(err instanceof Error ? err.message : '发送失败');
    } finally {
      setSendingEmailCode(false);
    }
  }

  async function beginEmailChange(): Promise<void> {
    emailForm.resetFields();
    const verified = await ensureStepUp({ force: true, passwordOnly: true });
    if (verified) setEmailModal(true);
  }

  async function verifyEmailChange(values: { newEmail: string; code: string }): Promise<void> {
    setEmailSending(true);
    try {
      await api('/api/user/email/change/verify', { method: 'POST', json: values });
      message.success('邮箱已更新');
      setEmailModal(false);
      setEmailCooldown(0);
      void refetch();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '验证失败');
    } finally {
      setEmailSending(false);
    }
  }

  async function requestDelete(): Promise<void> {
    const ok = await ensureStepUp();
    if (!ok) return;
    setDeleteModal(true);
  }

  async function confirmDelete(): Promise<void> {
    try {
      await api('/api/user/delete/request', { method: 'POST' });
      message.warning('注销申请已提交，7 天内可撤回');
      setDeleteModal(false);
      void refetch();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败');
    }
  }

  async function cancelDelete(): Promise<void> {
    await api('/api/user/delete/cancel', { method: 'POST' });
    message.success('已撤回注销申请');
    void refetch();
  }

  async function kickSession(row: SessionRow): Promise<void> {
    await api(`/api/user/sessions/${row.id}`, { method: 'DELETE' });
    message.success('已下线该会话');
    void loadSessions();
  }

  return (
    <div className="aap-account-page">
      {stepUpModal}
      {me.user.status === 'deletion_pending' ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="账号注销中"
          description="账号将在 7 天后删除并匿名化，期间可随时撤回。"
          action={
            <Button size="small" danger onClick={() => void cancelDelete()}>
              撤回注销
            </Button>
          }
        />
      ) : null}

      <header className="aap-account-heading">
        <Typography.Text className="aap-account-eyebrow">{sectionDetails[accountTab].group}</Typography.Text>
        <Typography.Title level={2}>{sectionDetails[accountTab].title}</Typography.Title>
        <Typography.Paragraph>{sectionDetails[accountTab].description}</Typography.Paragraph>
      </header>

      <Tabs
        className="aap-account-tabs"
        animated={false}
        tabPosition="left"
        items={[
          {
            key: 'profile',
            label: <span className="aap-account-tab-label"><span className="aap-account-tab-group">账户和安全</span><span>个人资料</span></span>,
            forceRender: true,
            children: (
              <div id="account-section-profile" className="aap-account-section">
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Card size="small" title="基础资料">
                  <Form form={profileForm} layout="vertical" onFinish={saveProfile} style={{ maxWidth: 420 }}>
                    <Form.Item name="name" label="昵称" rules={[{ required: true, message: '昵称不能为空' }]}>
                      <Input maxLength={64} />
                    </Form.Item>
                    <Descriptions column={1} size="small" style={{ marginBottom: 16 }}>
                      <Descriptions.Item label="用户名">{user.username ?? '—'}</Descriptions.Item>
                      <Descriptions.Item label="邮箱">{user.email ?? '未绑定'}</Descriptions.Item>
                      <Descriptions.Item label="角色">
                        {user.role === 'admin' ? <Tag color="gold">管理员</Tag> : <Tag>用户</Tag>}
                      </Descriptions.Item>
                    </Descriptions>
                    <Space wrap>
                      <Button type="primary" htmlType="submit" loading={saving}>
                        保存
                      </Button>
                      <Button loading={exportingInviteCard} onClick={() => void exportInviteCard()}>
                        导出邀请电子卡
                      </Button>
                    </Space>
                  </Form>
                </Card>
                <Card size="small" title="绑定邮箱">
                  <Typography.Paragraph type="secondary">
                    当前：{user.email ?? '未绑定'}。换绑需先验证身份，再验证新邮箱。
                  </Typography.Paragraph>
                  <Button
                    onClick={() => void beginEmailChange()}
                  >
                    换绑邮箱
                  </Button>
                </Card>
                <Card size="small" title="注销账号">
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="注销后 7 天冷静期，期间可撤回"
                    description="冷静期结束后，账号数据将被匿名化且不可恢复；审计记录按合规要求脱敏保留。"
                  />
                  <Button danger onClick={() => void requestDelete()}>
                    申请注销账号
                  </Button>
                </Card>
              </Space>
              </div>
            ),
          },
          {
            key: 'security',
            label: <span className="aap-account-tab-label"><span className="aap-account-tab-group aap-account-tab-group--hidden">账户和安全</span><span>安全设置</span></span>,
            forceRender: true,
            children: (
              <div id="account-section-security" className="aap-account-section">
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Card size="small" title="修改密码">
                  <Form layout="vertical" onFinish={changePassword} style={{ maxWidth: 420 }}>
                    <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true }]}>
                      <Input.Password />
                    </Form.Item>
                    <Form.Item
                      name="newPassword"
                      label="新密码"
                      rules={[
                        { required: true },
                        {
                          validator: (_, value: string | undefined) =>
                            !value || isPasswordValid(value)
                              ? Promise.resolve()
                              : Promise.reject(new Error(PASSWORD_POLICY_MESSAGE)),
                        },
                      ]}
                    >
                      <Input.Password placeholder="8-128 位，含大写、小写字母和数字" />
                    </Form.Item>
                    <Button htmlType="submit" type="primary">
                      修改密码
                    </Button>
                  </Form>
                </Card>
                <Card size="small" title="多因子认证（MFA）" extra={user.mfaEnabled ? <Tag color="green">已启用</Tag> : <Tag color="orange">未启用</Tag>}>
                  <MfaManageBody ensureStepUp={ensureStepUp} theme={activeUserPageTheme} />
                </Card>
                <Card size="small" title="登录会话">
                  <Table<SessionRow>
                    size="small"
                    rowKey="id"
                    dataSource={sessions}
                    pagination={false}
                    columns={[
                      {
                        title: '设备 / IP',
                        render: (_, r) => (
                          <div>
                            <div style={{ fontSize: 12 }}>{(r.userAgent ?? '未知设备').slice(0, 60)}</div>
                            <div style={{ color: 'var(--aap-text-secondary)', fontSize: 12 }}>{r.ip ?? '—'}</div>
                          </div>
                        ),
                      },
                      {
                        title: '最近活跃',
                        width: 150,
                        render: (_, r) => new Date(r.lastSeenAt).toLocaleString(),
                      },
                      {
                        title: '',
                        width: 110,
                        render: (_, r) =>
                          r.current ? (
                            <Tag>当前会话</Tag>
                          ) : (
                            <Popconfirm title="下线该会话？" onConfirm={() => void kickSession(r)}>
                              <Button size="small" danger>
                                踢下线
                              </Button>
                            </Popconfirm>
                          ),
                      },
                    ]}
                  />
                </Card>
              </Space>
              </div>
            ),
          },
          {
            key: 'myapps',
            label: <span className="aap-account-tab-label"><span className="aap-account-tab-group">应用</span><span>应用管理</span></span>,
            forceRender: true,
            children: (
              <div id="account-section-myapps" className="aap-account-section aap-account-section--myapps">
                <MyAppsTab active ensureStepUp={ensureStepUp} theme={activeUserPageTheme} />
              </div>
            ),
          },
          {
            key: 'benefits',
            label: <span className="aap-account-tab-label"><span className="aap-account-tab-group">权益</span><span>订阅与用量</span></span>,
            forceRender: true,
            children: <div id="account-section-benefits" className="aap-account-section"><MembershipTopupTab section="benefits" theme={activeUserPageTheme} /></div>,
          },
          {
            key: 'plans',
            label: '获取权益',
            forceRender: true,
            children: <div id="account-section-plans" className="aap-account-section"><MembershipTopupTab section="acquire" theme={activeUserPageTheme} /></div>,
          },
        ].filter((tab) => tab.key === accountTab)}
      />

      <Modal
        title="换绑邮箱"
        open={emailModal}
        onCancel={() => {
          setEmailModal(false);
          setEmailCooldown(0);
        }}
        footer={null}
        destroyOnClose
        rootClassName={`aap-account-modal aap-account-modal--${activeUserPageTheme}`}
      >
        <Form form={emailForm} layout="vertical" onFinish={verifyEmailChange}>
          <Form.Item
            name="newEmail"
            label="新邮箱"
            rules={[{ required: true, message: '请输入新邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}
          >
            <Input autoComplete="email" placeholder="请输入新邮箱地址" />
          </Form.Item>
          <div className="aap-email-change-code-row">
            <Form.Item name="code" rules={[{ required: true, message: '请输入验证码' }]}>
              <Input maxLength={6} inputMode="numeric" autoComplete="one-time-code" placeholder="请输入验证码" />
            </Form.Item>
            <Button
              loading={sendingEmailCode}
              disabled={sendingEmailCode || emailCooldown > 0}
              onClick={() => void sendEmailCode()}
            >
              {emailCooldown > 0 ? `重新发送（${emailCooldown}秒）` : '发送验证码'}
            </Button>
          </div>
          <Button type="primary" htmlType="submit" block loading={emailSending}>
            确认换绑
          </Button>
        </Form>
      </Modal>

      <Modal
        title="确认注销账号"
        open={deleteModal}
        onCancel={() => setDeleteModal(false)}
        footer={null}
        destroyOnClose
        rootClassName={`aap-account-modal aap-account-modal--${activeUserPageTheme}`}
      >
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message="此操作不可逆（冷静期后）" />
        <Form form={deleteForm} onFinish={confirmDelete}>
          <Form.Item
            name="confirm"
            rules={[{ required: true, message: '请输入「注销」确认' }]}
          >
            <Input placeholder='输入「注销」以确认' />
          </Form.Item>
          <Button danger type="primary" htmlType="submit" block>
            提交注销申请
          </Button>
        </Form>
      </Modal>
    </div>
  );
}

// ---------- MFA 管理（A3：已绑因子的查看/解绑/恢复码重置；绑定新因子走 /mfa-setup） ----------

interface PasskeyRow {
  id: string;
  nickname: string;
  createdAt: number;
  lastUsedAt: number | null;
  deviceType: string | null;
  backedUp: boolean;
}

interface MfaStatus {
  totpConfirmed: boolean;
  passkeys: PasskeyRow[];
  recoveryRemaining: number;
}

function MfaManageBody({ ensureStepUp, theme }: {
  ensureStepUp: () => Promise<boolean>;
  theme: 'light' | 'dark';
}): ReactNode {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { refetch: refetchMe } = useSession();
  const status = useQuery({ queryKey: ['mfa-status'], queryFn: () => api<MfaStatus>('/api/auth/mfa/status') });
  const [busy, setBusy] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['mfa-status'] });
    void refetchMe(); // 解绑最后一个因子会翻转 mfaEnabled，卡片角标同步
  };

  /** 统一执行：步升窗口过期自动弹步升窗重验；失败如实透出服务端消息（如 admin 保底约束） */
  async function run(action: string, fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await withStepUp(ensureStepUp, fn);
      refresh();
    } catch (err) {
      message.error(err instanceof Error ? err.message : `${action}失败`);
    } finally {
      setBusy(false);
    }
  }

  const d = status.data;

  if (!d) {
    return <Typography.Text type="secondary">正在加载 MFA 状态…</Typography.Text>;
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        推荐 TOTP 验证器 + Passkey 双因子。管理员账号强制启用；绑定新因子可在下方或前往
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => navigate('/mfa-setup')}>
          绑定页
        </Button>
        。
      </Typography.Paragraph>

      <div>
        <Space>
          <Typography.Text>TOTP 验证器</Typography.Text>
          {d.totpConfirmed ? <Tag color="green">已绑定</Tag> : <Tag>未绑定</Tag>}
        </Space>
        {d.totpConfirmed ? (
          <Space style={{ marginLeft: 12 }} wrap>
            <Typography.Text type="secondary">恢复码剩余 {d.recoveryRemaining} 枚</Typography.Text>
            <Button
              size="small"
              loading={busy}
              onClick={() =>
                void run('重新生成恢复码', async () => {
                  const r = await api<{ recoveryCodes: string[] }>('/api/auth/mfa/recovery/regenerate', {
                    method: 'POST',
                  });
                  setNewCodes(r.recoveryCodes);
                })
              }
            >
              重新生成恢复码
            </Button>
            <Popconfirm
              title="解绑 TOTP 后需重新扫码绑定，确定？"
              onConfirm={() =>
                void run('解绑 TOTP', async () => {
                  await api('/api/auth/mfa/totp/disable', { method: 'POST' });
                })
              }
            >
              <Button size="small" danger loading={busy}>
                解绑 TOTP
              </Button>
            </Popconfirm>
          </Space>
        ) : (
          <Typography.Text type="secondary" style={{ marginLeft: 12 }}>尚未绑定</Typography.Text>
        )}
      </div>

      <Card
        type="inner"
        size="small"
        title={`Passkey（${d.passkeys.length}）`}
      >
        {d.passkeys.length ? (
          <Table<PasskeyRow>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={d.passkeys}
            columns={[
              { title: '名称', dataIndex: 'nickname', ellipsis: true },
              { title: '绑定时间', width: 170, render: (_, r) => new Date(r.createdAt).toLocaleString() },
              {
                title: '',
                width: 90,
                render: (_, r) => (
                  <Popconfirm
                    title="删除该 Passkey？"
                    onConfirm={() =>
                      void run('删除 Passkey', async () => {
                        await api(`/api/auth/mfa/passkeys/${r.id}`, { method: 'DELETE' });
                      })
                    }
                  >
                    <Button size="small" danger loading={busy}>
                      删除
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        ) : (
          <Typography.Text type="secondary">未绑定 Passkey</Typography.Text>
        )}
      </Card>

      <Space wrap>
        {!d.totpConfirmed ? (
          <Button size="small" type="primary" onClick={() => navigate('/mfa-setup')}>
            绑定 TOTP
          </Button>
        ) : null}
        <Button
          size="small"
          type="primary"
          className="aap-mfa-passkey-button"
          loading={busy}
          onClick={() =>
            void run('Passkey 绑定', () => registerNewPasskey(`Passkey ${new Date().toLocaleDateString()}`))
          }
        >
          注册本设备 Passkey
        </Button>
      </Space>

      <Modal
        title="新的恢复码"
        open={newCodes !== null}
        onCancel={() => setNewCodes(null)}
        rootClassName={`aap-account-modal aap-account-modal--${theme}`}
        footer={
          <Button type="primary" onClick={() => setNewCodes(null)}>
            我已保存
          </Button>
        }
      >
        <Alert
          type="warning"
          showIcon
          message="旧恢复码已全部失效"
          description="每个恢复码只能使用一次，用于验证器丢失时登录。关闭后不会再显示，请妥善保存。"
          style={{ marginBottom: 12 }}
        />
        <Card size="small">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontFamily: 'monospace' }}>
            {(newCodes ?? []).map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        </Card>
      </Modal>
    </Space>
  );
}

// ---------- 我的权益（M3：manual 渠道下单，管理员确认到账后生效） ----------

interface TopupResult {
  orderId: string;
  tokens?: number;
  priceFen: number;
}

interface MembershipSubscribeResult {
  orderId: string | null;
  activated: boolean;
  planName: string;
  priceCurrency?: 'CNY' | 'USD';
  priceFen?: number;
  priceCents?: number;
}

function yuan(fen: number): string {
  return `¥${(fen / 100).toFixed(2)}`;
}

function membershipDurationLabel(days: number): string {
  if (days === 30) return '月（30 天）';
  if (days === 90) return '季度（90 天）';
  if (days === 365) return '年（365 天）';
  return days >= 100_000 ? '长期' : `${days} 天`;
}

function MembershipTopupTab({ section, theme }: {
  section: 'benefits' | 'acquire';
  theme: 'light' | 'dark';
}): ReactNode {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['membership'], queryFn: () => api<UserMembershipData>('/api/user/membership') });
  const billing = useQuery({
    queryKey: ['billing'],
    queryFn: () => api<{ showTopupPanel: boolean; showOrdersPanel: boolean }>('/api/user/billing'),
  });
  const showTopup = billing.data?.showTopupPanel === true;
  const showOrders = billing.data?.showOrdersPanel === true;
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [redeemCode, setRedeemCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<MembershipPlanSummary | null>(null);

  async function subscribe(planId: number): Promise<void> {
    setBusy(true);
    try {
      const r = await api<MembershipSubscribeResult>('/api/user/membership/subscribe', { method: 'POST', json: { planId } });
      if (r.activated) message.success(`已获取「${r.planName}」，权益立即生效`);
      else {
        const price = r.priceCurrency === 'USD' ? `$${((r.priceCents ?? 0) / 100).toFixed(2)}` : yuan(r.priceFen ?? 0);
        message.info(`订单已创建（${price}），等待管理员确认到账后生效`);
      }
      setSelectedPlan(null);
      void qc.invalidateQueries({ queryKey: ['membership'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '下单失败');
    } finally {
      setBusy(false);
    }
  }

  async function topup(fen: number): Promise<void> {
    setBusy(true);
    try {
      const r = await api<TopupResult>('/api/user/topup', { method: 'POST', json: { priceFen: fen } });
      message.info(`额度订单已提交（${yuan(fen)} → ${r.tokens?.toLocaleString()} Token 额度），确认后即可使用`);
      void qc.invalidateQueries({ queryKey: ['membership'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '下单失败');
    } finally {
      setBusy(false);
    }
  }

  const d = data.data;
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {billing.isError ? (
        <Alert
          type="error"
          showIcon
          message="权益显示设置加载失败"
          description={billing.error instanceof Error ? billing.error.message : '请刷新页面重试'}
        />
      ) : null}
      {section === 'benefits' ? (
      <Card
        size="small"
        className="membership-current-plan"
        title={
          <Space size={8}>
            <span>当前权益详情</span>
            {d?.membership ? <TierBadge tier={d.membership.tier} /> : null}
            <Typography.Text style={{ fontSize: 12, color: '#D6A542' }}>
              {d?.membership?.planName ?? '未订阅'}
            </Typography.Text>
          </Space>
        }
      >
        <div className="membership-current-plan__summary">
          <div className="membership-current-plan__eyebrow">权益概览</div>
          <div className="membership-current-plan__grid">
            <div className="membership-current-plan__item">
              <Typography.Text type="secondary">到期时间</Typography.Text>
              <Typography.Text strong className="membership-current-plan__value">{d?.membership ? new Date(d.membership.expiresAt).toLocaleString() : '—'}</Typography.Text>
            </div>
            <div className="membership-current-plan__item">
              <Typography.Text type="secondary">权益分组</Typography.Text>
              <Typography.Text strong className="membership-current-plan__value">{d?.membership?.groupName ?? '—'}</Typography.Text>
            </div>
            <div className="membership-current-plan__item">
              <Typography.Text type="secondary">可创建应用</Typography.Text>
              <Typography.Text strong className="membership-current-plan__value">
                {d?.membership
                  ? `${formatEntitlementCount(d.membership.remainingUploadApps)} / ${formatEntitlementCount(d.membership.appUploadLimit, ' 个')}`
                  : '—'}
              </Typography.Text>
            </div>
            <div className="membership-current-plan__item">
              <Typography.Text type="secondary">可克隆应用</Typography.Text>
              <Typography.Text strong className="membership-current-plan__value">
                {d?.membership
                  ? `${formatEntitlementCount(d.membership.remainingCloneApps)} / ${formatEntitlementCount(d.membership.appCloneLimit, ' 个')}`
                  : '—'}
              </Typography.Text>
            </div>
            <div className="membership-current-plan__item">
              <Typography.Text type="secondary">剩余 Token 额度</Typography.Text>
              <Typography.Text strong className="membership-current-plan__value">
                {d?.tokenBalance === undefined ? '—' : formatEntitlementCount(d.tokenBalance)}
              </Typography.Text>
            </div>
            <div className="membership-current-plan__item">
              <Typography.Text type="secondary">可用积分</Typography.Text>
              <Typography.Text strong className="membership-current-plan__value">
                {d?.pointsBalance === undefined ? '—' : formatEntitlementCount(d.pointsBalance)}
              </Typography.Text>
            </div>
          </div>
        </div>
      </Card>
      ) : null}

      {section === 'acquire' ? (
      <Card size="small" className="membership-plan-card" title="可选择权益包">
        {d?.plans.length ? (
          <div className="membership-plan-grid">
            {d.plans.map((plan) => (
              <Card
                key={plan.id}
                size="small"
                className="membership-plan-option"
                title={
                  <Space wrap>
                    <TierBadge tier={plan.tier} />
                    <Typography.Text strong>{plan.name}</Typography.Text>
                  </Space>
                }
              >
                <div className="membership-plan-option__details">
                  <div><Typography.Text type="secondary">权益分组</Typography.Text><Typography.Text>{plan.groupName}</Typography.Text></div>
                  <div><Typography.Text type="secondary">可用时间</Typography.Text><Typography.Text>{membershipDurationLabel(plan.durationDays)}</Typography.Text></div>
                  <div><Typography.Text type="secondary">可创建应用</Typography.Text><Typography.Text>{formatEntitlementCount(plan.appUploadLimit, ' 个')}</Typography.Text></div>
                  <div><Typography.Text type="secondary">可克隆应用</Typography.Text><Typography.Text>{formatEntitlementCount(plan.appCloneLimit, ' 个')}</Typography.Text></div>
                  <div><Typography.Text type="secondary">Token 额度</Typography.Text><Typography.Text>{formatEntitlementCount(plan.tokenGrant)}</Typography.Text></div>
                </div>
                <div className="membership-plan-option__footer">
                  <Typography.Text strong style={{ color: 'var(--aap-primary)' }}>{formatMembershipPlanPrice(plan)}</Typography.Text>
                  <Button type="primary" disabled={!plan.enabled} onClick={() => setSelectedPlan(plan)}>获取</Button>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <Typography.Text type="secondary">暂无可选择权益包</Typography.Text>
        )}
      </Card>
      ) : null}

      {section === 'acquire' ? (
      <Card size="small" title="使用兑换码获取权益">
        <Space wrap>
          <Input
            style={{ width: 240 }}
            placeholder="输入兑换码，如 AAP-XXXX-XXXX-XXXX"
            value={redeemCode}
            onChange={(e) => setRedeemCode(e.target.value.toUpperCase())}
          />
          <Button
            type="primary"
            loading={redeeming}
            onClick={async () => {
              if (!redeemCode.trim()) return message.warning('请输入兑换码');
              setRedeeming(true);
              try {
                const r = await api<{ kind: string; tokens?: number; planName?: string }>('/api/user/redeem', {
                  method: 'POST',
                  json: { code: redeemCode },
                });
                if (r.kind === 'tokens') message.success(`兑换成功：到账 ${r.tokens?.toLocaleString()} 额度`);
                else message.success(`兑换成功：功能订阅「${r.planName}」已开通`);
                setRedeemCode('');
                void qc.invalidateQueries({ queryKey: ['membership'] });
                void qc.invalidateQueries({ queryKey: ['billing'] });
              } catch (err) {
                message.error(err instanceof Error ? err.message : '兑换失败');
              } finally {
                setRedeeming(false);
              }
            }}
          >
            立即兑换
          </Button>
        </Space>
      </Card>
      ) : null}

      {section === 'acquire' && showTopup ? (
      <Card size="small" title="获取 Token 额度">
        <Space wrap>
          {[1000, 5000, 10000].map((fen) => (
            <Button key={fen} onClick={() => void topup(fen)} loading={busy}>
              {yuan(fen)} → {(fen * 10).toLocaleString()} Token 额度
            </Button>
          ))}
          <Input
            style={{ width: 140 }}
            placeholder="自定义金额（元）"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Button
            onClick={() => {
              const yuan_ = Number(amount);
              if (Number.isFinite(yuan_) && yuan_ >= 1) void topup(Math.round(yuan_ * 100));
              else message.warning('最低 1 元');
            }}
          >
            获取额度
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
          当前参考标准为 1 元对应 1000 Token 额度（管理员可调整）。提交后生成额度订单，确认后即可使用。
        </Typography.Paragraph>
      </Card>
      ) : null}

      {section === 'benefits' && showOrders ? (
      <Card size="small" className="membership-history" title="历史订阅">
        <Table<MembershipOrderSummary>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={d?.orders.filter((order) => order.kind === 'membership') ?? []}
          columns={[
            { title: '订单号', dataIndex: 'id', width: 170 },
            { title: '提交时间', width: 180, render: (_, r) => new Date(r.createdAt).toLocaleString() },
            { title: '金额', width: 100, render: (_, r) => formatMembershipOrderPrice(r) },
            { title: '内容', width: 110, render: () => '订阅权益' },
            {
              title: '状态',
              width: 90,
              render: (_, r) =>
                r.status === 'pending' ? <Tag color="orange">待确认</Tag> : r.status === 'paid' ? <Tag color="green">已到账</Tag> : <Tag>已取消</Tag>,
            },
            {
              title: '',
              width: 90,
              render: (_, r) =>
                r.status === 'pending' ? (
                  <Button
                    size="small"
                    onClick={async () => {
                      await api(`/api/user/orders/${r.id}/cancel`, { method: 'POST' });
                      void qc.invalidateQueries({ queryKey: ['membership'] });
                    }}
                  >
                    取消
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
      ) : null}

      <Modal
        title="订阅详情"
        open={selectedPlan !== null}
        onCancel={() => setSelectedPlan(null)}
        footer={null}
        destroyOnClose
        rootClassName={`aap-account-modal aap-account-modal--${theme}`}
      >
        {selectedPlan ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <section className="aap-subscription-bill" aria-label="订阅详情">
              <header className="aap-subscription-bill__header">
                <span>订阅方案</span>
                <strong>{selectedPlan.name}</strong>
                <span><b>等级 {selectedPlan.tier}</b><i />{membershipDurationLabel(selectedPlan.durationDays)}</span>
              </header>
              <div className="aap-subscription-bill__details">
                <div><span>权益等级</span><strong>{selectedPlan.tier}<small>级</small></strong></div>
                <div><span>服务分组</span><strong>{selectedPlan.groupName}</strong></div>
                <div><span>可创建应用</span><strong>{formatEntitlementCount(selectedPlan.appUploadLimit, ' 个')}</strong></div>
                <div><span>可克隆应用</span><strong>{formatEntitlementCount(selectedPlan.appCloneLimit, ' 个')}</strong></div>
                <div><span>Token 额度</span><strong>{formatEntitlementCount(selectedPlan.tokenGrant)}</strong></div>
              </div>
              <div className="aap-subscription-bill__total">
                <strong>应付总额</strong>
                <span>{formatMembershipPlanPrice(selectedPlan)}</span>
              </div>
            </section>
            <div className={`aap-subscription-bill__notice${selectedPlan.priceCurrency === 'POINTS' && (d?.pointsBalance ?? 0) < selectedPlan.pricePoints ? ' is-warning' : ''}`}>
              <strong>{selectedPlan.priceCurrency === 'POINTS' ? '积分兑换' : '订阅说明'}</strong>
              {selectedPlan.priceCurrency === 'POINTS' ? (
                <p>
                  需支付 <b>{selectedPlan.pricePoints.toLocaleString()}</b> 积分，当前余额 <b>{(d?.pointsBalance ?? 0).toLocaleString()}</b> 积分。
                  积分足额后立即扣减并开通。
                </p>
              ) : (
                <p>
                  {isFreeMembershipPlan(selectedPlan)
                    ? '此权益包免费，确认后立即开通。'
                    : '提交订单后请完成付款，由管理员确认到账后开通订阅权益。'}
                </p>
              )}
            </div>
            {selectedPlan.redeemUrl ? (
              <div style={{ textAlign: 'right' }}>
                <Typography.Link
                  href={selectedPlan.redeemUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: 'underline' }}
                >
                  当前方案支持兑换码?去获取
                </Typography.Link>
              </div>
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button onClick={() => setSelectedPlan(null)}>取消</Button>
              <Button
                type="primary"
                loading={busy}
                disabled={selectedPlan.priceCurrency === 'POINTS' && (d?.pointsBalance ?? 0) < selectedPlan.pricePoints}
                onClick={() => void subscribe(selectedPlan.id)}
              >
                {selectedPlan.priceCurrency === 'POINTS'
                  ? '立即兑换'
                  : isFreeMembershipPlan(selectedPlan)
                    ? '立即获取'
                    : '支付并提交订单'}
              </Button>
            </div>
          </Space>
        ) : null}
      </Modal>
    </Space>
  );
}

// ---------- 我的应用（.awpk 上传与发布） ----------

type MyAppRow = OwnedAppCard;

const PLATFORM_CAPABILITY_ICONS: Record<string, { file: string; label: string }> = {
  db: { file: 'database.svg', label: '数据库' },
  llm: { file: 'llm.svg', label: '大模型' },
  storage: { file: 'storage.svg', label: '存储' },
};

function platformCapabilityIcons(app: MyAppRow): Array<{ file: string; label: string }> {
  const icons = app.capabilities
    .map((capability) => PLATFORM_CAPABILITY_ICONS[capability])
    .filter((icon): icon is { file: string; label: string } => icon !== undefined);
  if (app.network?.length) icons.push({ file: 'network.svg', label: '网络白名单' });
  return icons;
}

function formatPackageSize(bytes: number | null): string {
  if (bytes == null) return '未记录（旧版本）';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function MyAppsTab({ active, ensureStepUp, theme }: {
  active: boolean;
  ensureStepUp: () => Promise<boolean>;
  theme: 'light' | 'dark';
}): ReactNode {
  const qc = useQueryClient();
  const mine = useQuery({
    queryKey: ['my-apps'],
    queryFn: () => api<{ apps: MyAppRow[] }>('/api/apps/mine'),
    enabled: active,
  });
  const [uploading, setUploading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [settingsApp, setSettingsApp] = useState<MyAppRow | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    setLastError(null);
    try {
      const dataBase64 = bytesToBase64(new Uint8Array(await f.arrayBuffer()));
      const r = await api<{ id: string }>('/api/apps/submit', { method: 'POST', json: { filename: f.name, dataBase64 } });
      message.success(`包「${r.id}」上传成功，默认仅自己可见`);
      void qc.invalidateQueries({ queryKey: ['my-apps'] });
    } catch (err) {
      setLastError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="上传 .awpk 包" extra={<Tag bordered={false} color="blue" style={{ fontSize: 11 }}>python 沙箱运行时已上线</Tag>}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          平台按当前权益包限制可创建应用数量（通过上传应用包创建）；创建后默认仅自己可见，发布为公开不再受数量限制。
        </Typography.Paragraph>
        <Button danger disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          选择文件
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".awpk"
          onChange={(e) => void onFile(e)}
          disabled={uploading}
          style={{ display: 'none' }}
        />
        {uploading ? <Typography.Text type="secondary">上传校验中…</Typography.Text> : null}
        {lastError ? <Alert type="error" showIcon style={{ marginTop: 10 }} message={lastError} /> : null}
      </Card>

      <Card size="small" title="已创建应用">
        {mine.isError ? (
          <Alert
            type="error"
            showIcon
            message="应用列表加载失败"
            description={mine.error instanceof Error ? mine.error.message : '请重试'}
            action={<Button size="small" onClick={() => void mine.refetch()}>重试</Button>}
          />
        ) : (
          <Table<MyAppRow>
            rowKey="id"
            className="aap-owned-apps-table"
            size="small"
            tableLayout="fixed"
            pagination={{ pageSize: 10, showSizeChanger: false }}
            loading={mine.isLoading}
            dataSource={mine.data?.apps ?? []}
            columns={[
              {
                title: '应用',
                width: 150,
                render: (_, app) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Text strong>{app.name}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>{app.id}</Typography.Text>
                  </Space>
                ),
              },
              {
                title: '安装日期',
                width: 96,
                render: (_, app) => <Typography.Text type="secondary">{new Date(app.installedAt).toLocaleDateString('zh-CN')}</Typography.Text>,
              },
              {
                title: '包大小',
                width: 76,
                render: (_, app) => <Typography.Text type="secondary">{formatPackageSize(app.packageSizeBytes)}</Typography.Text>,
              },
              {
                title: '版本',
                width: 72,
                render: (_, app) => <Typography.Text type="secondary">{app.version ?? '—'}</Typography.Text>,
              },
              {
                title: '平台支持',
                width: 112,
                render: (_, app) => {
                  const icons = platformCapabilityIcons(app);
                  return icons.length > 0
                    ? (
                      <Space size={6}>
                        {icons.map((icon) => (
                          <img
                            key={icon.file}
                            src={withBase(`/assets/ui-icons/${icon.file}`)}
                            alt={icon.label}
                            title={icon.label}
                            width={20}
                            height={20}
                            style={{ display: 'block' }}
                          />
                        ))}
                      </Space>
                    )
                    : <Typography.Text type="secondary">—</Typography.Text>;
                },
              },
              { title: '运行', width: 88, render: (_, r) => r.kind === 'html' ? 'HTML 页面' : r.runtimeMode === 'invoked' ? '按调用' : r.runtimeMode === 'persistent' ? '持久服务' : '—' },
              {
                title: '可见范围',
                width: 96,
                render: (_, r) => (
                  <Tag
                    color={r.visibility === 'public' ? 'green' : r.visibility === 'private' ? 'default' : 'blue'}
                  >
                    {r.visibility === 'public' ? '公开' : r.visibility === 'private' ? '仅自己' : '站内'}
                  </Tag>
                ),
              },
              {
                title: '操作',
                width: 76,
                render: (_, r) => (
                  <Space size="small">
                    <Tooltip title="设置应用">
                      <Button
                        size="small"
                        aria-label={`设置应用「${r.name}」`}
                        icon={<SettingOutlined />}
                        onClick={() => setSettingsApp(r)}
                      />
                    </Tooltip>
                    <Popconfirm
                      title={`删除应用「${r.name}」？`}
                      description="应用文件和运行数据将被永久删除。"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={async () => {
                        const verified = await ensureStepUp();
                        if (!verified) return;
                        try {
                          const result = await api<{ pointsDeducted: number }>(`/api/apps/${r.id}`, { method: 'DELETE' });
                          message.success(
                            result.pointsDeducted > 0
                              ? `应用已删除，扣回 ${result.pointsDeducted} 积分`
                              : '应用已删除',
                          );
                          if (result.pointsDeducted > 0) void qc.invalidateQueries({ queryKey: ['membership'] });
                          void qc.invalidateQueries({ queryKey: ['my-apps'] });
                          void qc.invalidateQueries({ queryKey: ['apps'] });
                        } catch (err) {
                          message.error(err instanceof Error ? err.message : '删除失败');
                        }
                      }}
                    >
                      <Tooltip title="删除应用">
                        <Button size="small" danger aria-label={`删除应用「${r.name}」`} icon={<DeleteOutlined />} />
                      </Tooltip>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <AppSettingsModal
        app={settingsApp}
        open={settingsApp != null}
        onClose={() => setSettingsApp(null)}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: ['my-apps'] });
          void qc.invalidateQueries({ queryKey: ['shared-apps'] });
          void qc.invalidateQueries({ queryKey: ['apps'] });
        }}
        theme={theme}
      />
    </Space>
  );
}
