/**
 * 用户中心（A4）：个人信息 / 安全（改密、MFA、会话管理）/ 账单（M3 占位）/ 注销。
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
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { obtainPowToken } from '../lib/pow';
import { useSession } from '../state/session';
import { useStepUp, withStepUp } from '../components/StepUpModal';
import { registerNewPasskey } from '../lib/mfaClient';
import { AppEnvModal } from '../components/AppEnvModal';
import { TierBadge } from '../components/TierBadge';
import type { MembershipOrderSummary, MembershipPlanSummary, UserMembershipData } from '@aap/shared';
import { formatMembershipOrderPrice, formatMembershipPlanPrice, isFreeMembershipPlan } from '../lib/membershipPricing';

// ---------- 主页面 ----------

interface SessionRow {
  id: string;
  current: boolean;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
}

const ACCOUNT_TABS = ['profile', 'security', 'myapps', 'billing'] as const;
type AccountTabKey = (typeof ACCOUNT_TABS)[number];

export function AccountPage() {
  const { activeUserPageTheme } = useOutletContext<{ activeUserPageTheme: 'light' | 'dark' }>();
  const { me, refetch } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const [stepUpModal, ensureStepUp] = useStepUp(activeUserPageTheme);
  const [profileForm] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [emailModal, setEmailModal] = useState(false);
  const [emailForm] = Form.useForm();
  const [deleteModal, setDeleteModal] = useState(false);
  const [deleteForm] = Form.useForm();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sending, setSending] = useState(false);
  const [emailSending, setEmailSending] = useState(false);

  const user = me?.user;
  const requestedTab = searchParams.get('tab');
  const accountTab = ACCOUNT_TABS.find((tab) => tab === requestedTab) ?? ACCOUNT_TABS[0];
  const [activeAccountTab, setActiveAccountTab] = useState<AccountTabKey>(accountTab);

  useEffect(() => {
    setActiveAccountTab(accountTab);
    if (!requestedTab) return;
    requestAnimationFrame(() => {
      document.getElementById(`account-section-${accountTab}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [accountTab, requestedTab]);

  useEffect(() => {
    let frame = 0;
    const syncActiveSection = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const activationLine = 160;
        let current: AccountTabKey = ACCOUNT_TABS[0];
        for (const key of ACCOUNT_TABS) {
          const section = document.getElementById(`account-section-${key}`);
          if (section && section.getBoundingClientRect().top <= activationLine) current = key;
        }
        if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
          current = 'billing';
        }
        setActiveAccountTab(current);
      });
    };

    window.addEventListener('scroll', syncActiveSection, { passive: true });
    window.addEventListener('resize', syncActiveSection);
    syncActiveSection();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', syncActiveSection);
      window.removeEventListener('resize', syncActiveSection);
    };
  }, []);

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
    if (me) void loadSessions();
  }, [me]);

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

  async function changePassword(values: { currentPassword: string; newPassword: string }): Promise<void> {
    try {
      await api('/api/auth/change-password', { method: 'POST', json: values });
      message.success('密码已修改，其他设备已退出登录');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '修改失败');
    }
  }

  async function sendEmailCode(newEmail: string): Promise<void> {
    setSending(true);
    try {
      const ok = await ensureStepUp();
      if (!ok) return;
      const powToken = await obtainPowToken();
      const r = await api<{ sentTo: string; viaLogFallback: boolean }>('/api/user/email/change/start', {
        method: 'POST',
        json: { newEmail, powToken },
      });
      message.success(r.viaLogFallback ? '验证码在服务端日志中' : `验证码已发送至 ${r.sentTo}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'STEP_UP_REQUIRED') {
        message.info('请先完成身份验证');
      } else {
        message.error(err instanceof Error ? err.message : '发送失败');
      }
    } finally {
      setSending(false);
    }
  }

  async function verifyEmailChange(values: { newEmail: string; code: string }): Promise<void> {
    setEmailSending(true);
    try {
      await api('/api/user/email/change/verify', { method: 'POST', json: values });
      message.success('邮箱已更新');
      setEmailModal(false);
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

      <div className="aap-account-heading">
        <Typography.Text className="aap-account-eyebrow">ACCOUNT</Typography.Text>
        <Typography.Title level={2}>个人中心</Typography.Title>
        <Typography.Paragraph>管理你的个人资料、安全设置、应用和账户权益。</Typography.Paragraph>
      </div>

      <Tabs
        className="aap-account-tabs"
        animated={false}
        tabPosition="left"
        items={[
          {
            key: 'profile',
            label: '个人资料',
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
                    <Button type="primary" htmlType="submit" loading={saving}>
                      保存
                    </Button>
                  </Form>
                </Card>
                <Card size="small" title="绑定邮箱">
                  <Typography.Paragraph type="secondary">
                    当前：{user.email ?? '未绑定'}。换绑需先验证身份，再验证新邮箱。
                  </Typography.Paragraph>
                  <Button
                    onClick={() => {
                      emailForm.resetFields();
                      setEmailModal(true);
                    }}
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
            label: '账户安全',
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
                      rules={[{ required: true }, { min: 8, max: 128, message: '8-128 位' }]}
                    >
                      <Input.Password />
                    </Form.Item>
                    <Button htmlType="submit" type="primary">
                      修改密码
                    </Button>
                  </Form>
                </Card>
                <Card size="small" title="多因子认证（MFA）" extra={user.mfaEnabled ? <Tag color="green">已启用</Tag> : <Tag color="orange">未启用</Tag>}>
                  <MfaManageBody ensureStepUp={ensureStepUp} />
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
            label: '应用管理',
            forceRender: true,
            children: (
              <div id="account-section-myapps" className="aap-account-section aap-account-section--myapps">
                <MyAppsTab active={activeAccountTab === 'myapps'} ensureStepUp={ensureStepUp} />
              </div>
            ),
          },
          {
            key: 'billing',
            label: '我的权益',
            forceRender: true,
            children: <div id="account-section-billing" className="aap-account-section"><MembershipTopupTab /></div>,
          },
        ]}
        activeKey={activeAccountTab}
        onChange={(key) => {
          setActiveAccountTab(key as AccountTabKey);
          setSearchParams({ tab: key });
        }}
      />

      <Modal
        title="换绑邮箱"
        open={emailModal}
        onCancel={() => setEmailModal(false)}
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
            <Input
              onBlur={undefined}
              onPressEnter={undefined}
              onChange={(e) => emailForm.setFieldValue('newEmail', e.target.value)}
            />
          </Form.Item>
          <Button
            block
            style={{ marginBottom: 12 }}
            loading={emailSending}
            onClick={async () => {
              const newEmail = String(emailForm.getFieldValue('newEmail') ?? '');
              setSending(true);
              try {
                const ok = await ensureStepUp();
                if (!ok) return;
                const powToken = await obtainPowToken();
                const r = await api<{ sentTo: string; viaLogFallback: boolean }>('/api/user/email/change/start', {
                  method: 'POST',
                  json: { newEmail, powToken },
                });
                message.success(r.viaLogFallback ? '验证码在服务端日志中' : `验证码已发送至 ${r.sentTo}`);
              } catch (err) {
                if (err instanceof ApiError && err.code === 'STEP_UP_REQUIRED') {
                  message.info('请先在弹窗中验证身份');
                } else {
                  message.error(err instanceof Error ? err.message : '发送失败');
                }
              } finally {
                setSending(false);
              }
            }}
          >
            发送验证码（需先验证身份）
          </Button>
          <Form.Item name="code" label="验证码" rules={[{ required: true, message: '请输入验证码' }]}>
            <Input maxLength={6} placeholder="6 位验证码" />
          </Form.Item>
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

function MfaManageBody({ ensureStepUp }: { ensureStepUp: () => Promise<boolean> }): ReactNode {
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
          <Button size="small" type="primary" style={{ marginLeft: 12 }} onClick={() => navigate('/mfa-setup')}>
            绑定 TOTP
          </Button>
        )}
      </div>

      <Card
        type="inner"
        size="small"
        title={`Passkey（${d.passkeys.length}）`}
        extra={
          <Button
            size="small"
            loading={busy}
            onClick={() =>
              void run('Passkey 绑定', () => registerNewPasskey(`Passkey ${new Date().toLocaleDateString()}`))
            }
          >
            注册本设备 Passkey
          </Button>
        }
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

      <Modal
        title="新的恢复码"
        open={newCodes !== null}
        onCancel={() => setNewCodes(null)}
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

function MembershipTopupTab(): ReactNode {
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
      message.info(`充值订单已创建（${yuan(fen)} → ${r.tokens?.toLocaleString()} 额度），等待确认到账`);
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
              <Typography.Text strong>{d?.membership ? new Date(d.membership.expiresAt).toLocaleString() : '—'}</Typography.Text>
            </div>
            <div className="membership-current-plan__item">
              <Typography.Text type="secondary">权益分组</Typography.Text>
              <Typography.Text strong>{d?.membership?.groupName ?? '—'}</Typography.Text>
            </div>
            <div className="membership-current-plan__item">
              <Typography.Text type="secondary">应用发布</Typography.Text>
              <Tag color="green" style={{ borderRadius: 999, marginInlineEnd: 0, width: 'fit-content' }}>
                {d?.membership ? `${d.membership.remainingPublicApps} / ${d.membership.publicAppLimit} 个` : '0 个'}
              </Tag>
            </div>
            <div className="membership-current-plan__item">
              <Typography.Text type="secondary">剩余 Token 额度</Typography.Text>
              <Tag color="green" style={{ borderRadius: 999, marginInlineEnd: 0, width: 'fit-content' }}>
                {d?.tokenBalance?.toLocaleString() ?? '—'}
              </Tag>
            </div>
            <div className="membership-current-plan__item">
              <Typography.Text type="secondary">可用积分</Typography.Text>
              <Tag color="blue" style={{ borderRadius: 999, marginInlineEnd: 0, width: 'fit-content' }}>
                {d?.pointsBalance?.toLocaleString() ?? '—'}
              </Tag>
            </div>
          </div>
        </div>
      </Card>

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
                    <Tag color={plan.enabled ? 'green' : 'default'}>{plan.enabled ? '在售' : '停售'}</Tag>
                  </Space>
                }
              >
                <div className="membership-plan-option__details">
                  <div><Typography.Text type="secondary">权益分组</Typography.Text><Typography.Text>{plan.groupName}</Typography.Text></div>
                  <div><Typography.Text type="secondary">可用时间</Typography.Text><Typography.Text>{membershipDurationLabel(plan.durationDays)}</Typography.Text></div>
                  <div><Typography.Text type="secondary">应用发布</Typography.Text><Typography.Text>{plan.publicAppLimit} 个</Typography.Text></div>
                  <div><Typography.Text type="secondary">Token 额度</Typography.Text><Typography.Text>{plan.tokenGrant.toLocaleString()}</Typography.Text></div>
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

      <Card size="small" title="使用兑换码">
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

      {showTopup ? (
      <Card size="small" title="额度充值">
        <Space wrap>
          {[1000, 5000, 10000].map((fen) => (
            <Button key={fen} onClick={() => void topup(fen)} loading={busy}>
              {yuan(fen)} → {(fen * 10).toLocaleString()} 额度
            </Button>
          ))}
          <Input
            style={{ width: 140 }}
            placeholder="自定义金额(元)"
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
            充值
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
          计费单价：1 元 = 1000 额度（管理员可调）。订单创建后等待确认到账，到账即入账。
        </Typography.Paragraph>
      </Card>
      ) : null}

      {showOrders ? (
      <Card size="small" title="我的订单">
        <Table<MembershipOrderSummary>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={d?.orders ?? []}
          columns={[
            { title: '订单号', dataIndex: 'id', width: 170 },
            { title: '类型', width: 80, render: (_, r) => (r.kind === 'membership' ? '订阅' : '额度') },
            { title: '金额', width: 100, render: (_, r) => formatMembershipOrderPrice(r) },
            { title: '到账', width: 110, render: (_, r) => (r.kind === 'tokens' ? `${r.tokens?.toLocaleString()} 额度` : '订阅权益') },
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

      <Modal title="订阅账单" open={selectedPlan !== null} onCancel={() => setSelectedPlan(null)} footer={null} destroyOnClose>
        {selectedPlan ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div style={{ padding: 16, borderRadius: 8, background: 'var(--aap-bg-layout)', border: '1px solid var(--aap-border)' }}>
              <Typography.Text type="secondary">订阅方案</Typography.Text>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 6 }}>
                <Space align="center" size={8}>
                  <TierBadge tier={selectedPlan.tier} />
                  <Typography.Title level={4} style={{ margin: 0 }}>{selectedPlan.name}</Typography.Title>
                </Space>
                <Tag color="blue">{membershipDurationLabel(selectedPlan.durationDays)}</Tag>
              </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px 16px', marginTop: 16 }}>
                    <Typography.Text type="secondary">权益等级</Typography.Text>
                    <TierBadge tier={selectedPlan.tier} />
                    <Typography.Text type="secondary">服务分组</Typography.Text>
                    <Typography.Text>{selectedPlan.groupName}</Typography.Text>
                <Typography.Text type="secondary">公开应用名额</Typography.Text>
                <Tag color="green" style={{ borderRadius: 999, marginInlineEnd: 0 }}>{selectedPlan.publicAppLimit} 个</Tag>
                <Typography.Text type="secondary">Token 额度</Typography.Text>
                <Tag color="green" style={{ borderRadius: 999, marginInlineEnd: 0 }}>{selectedPlan.tokenGrant.toLocaleString()}</Tag>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: '1px solid var(--aap-border)', marginTop: 16, paddingTop: 14 }}>
                <Typography.Text strong>应付总额</Typography.Text>
                <Typography.Title level={3} style={{ margin: 0, color: 'var(--aap-primary)' }}>{formatMembershipPlanPrice(selectedPlan)}</Typography.Title>
              </div>
            </div>
            <Alert
              type={selectedPlan.priceCurrency === 'POINTS' && (d?.pointsBalance ?? 0) < selectedPlan.pricePoints ? 'warning' : 'info'}
              showIcon
              message={selectedPlan.priceCurrency === 'POINTS' ? '积分兑换' : '确认订阅方案'}
              description={
                selectedPlan.priceCurrency === 'POINTS'
                  ? `兑换需要 ${selectedPlan.pricePoints.toLocaleString()} 积分，当前余额 ${(d?.pointsBalance ?? 0).toLocaleString()} 积分。积分足额后立即扣减并开通。`
                  : isFreeMembershipPlan(selectedPlan)
                    ? '这是零价权益包，确认后立即开通。'
                    : '提交订单后请完成付款；当前由管理员人工确认到账，确认后订阅权益自动生效。'
              }
            />
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

// ---------- 我的应用（.asp-app 上传与发布） ----------

interface MyAppRow {
  id: string;
  name: string;
  kind: 'package' | 'html';
  runtimeMode: string | null;
  visibility: string;
  enabled: boolean;
  updatedAt: number;
}

function MyAppsTab({ active, ensureStepUp }: { active: boolean; ensureStepUp: () => Promise<boolean> }): ReactNode {
  const qc = useQueryClient();
  const mine = useQuery({
    queryKey: ['my-apps'],
    queryFn: () => api<{ apps: MyAppRow[] }>('/api/apps/mine'),
    enabled: active,
  });
  const [uploading, setUploading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [envApp, setEnvApp] = useState<MyAppRow | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    setLastError(null);
    try {
      const dataBase64 = String(await f.arrayBuffer().then((b) => btoa(String.fromCharCode(...new Uint8Array(b)))));
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
      <Card size="small" title="上传 .asp-app 包" extra={<Tag bordered={false} color="blue" style={{ fontSize: 11 }}>python 沙箱运行时已上线</Tag>}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          无需签名，上传后默认仅自己可见可用；发布为公开时，平台会检查当前订阅允许的公开应用数量。
        </Typography.Paragraph>
        <Button danger disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          选择文件
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,.asp-app"
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
            size="small"
            pagination={false}
            loading={mine.isLoading}
            dataSource={mine.data?.apps ?? []}
            columns={[
              { title: '应用', dataIndex: 'id', width: 160 },
              { title: '运行', width: 110, render: (_, r) => r.kind === 'html' ? 'HTML 页面' : r.runtimeMode === 'invoked' ? '按调用' : r.runtimeMode === 'persistent' ? '持久服务' : '—' },
              { title: '可见范围', width: 120, render: (_, r) => r.visibility === 'public' ? <Tag color="green">公开</Tag> : <Tag>仅自己</Tag> },
              {
                title: '操作',
                width: 200,
                render: (_, r) => (
                  <Space size="small" wrap>
                    <Button size="small" onClick={() => setEnvApp(r)}>
                      环境变量
                    </Button>
                    {r.visibility !== 'public' ? (
                      <Button
                        size="small"
                        type="primary"
                        onClick={async () => {
                          try {
                            await api(`/api/apps/${r.id}/publish`, { method: 'POST' });
                            message.success('应用已公开发布');
                            void qc.invalidateQueries({ queryKey: ['my-apps'] });
                            void qc.invalidateQueries({ queryKey: ['apps'] });
                          } catch (err) {
                            message.error(err instanceof Error ? err.message : '发布失败');
                          }
                        }}
                      >
                        发布为公开
                      </Button>
                    ) : null}
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
                          await api(`/api/apps/${r.id}`, { method: 'DELETE' });
                          message.success('应用已删除');
                          void qc.invalidateQueries({ queryKey: ['my-apps'] });
                          void qc.invalidateQueries({ queryKey: ['apps'] });
                        } catch (err) {
                          message.error(err instanceof Error ? err.message : '删除失败');
                        }
                      }}
                    >
                      <Button size="small" danger>删除</Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <AppEnvModal appId={envApp?.id ?? ''} appName={envApp?.id ?? ''} open={envApp != null} onClose={() => setEnvApp(null)} />
    </Space>
  );
}
