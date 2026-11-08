/** 注册页（A2）：始终开放注册；两步注册（资料 → 邮箱或短信验证码）；全程 PoW。 */
import { Alert, Button, Form, Input, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { isPasswordValid, PASSWORD_POLICY_MESSAGE, type PortalBootstrap } from '@aap/shared';
import { api } from '../api/client';
import { obtainPowToken } from '../lib/pow';
import { usePostAuthRedirect } from '../state/session';
import { AuthPanel } from '../components/AuthPanel';
import { safeReturnTo } from '../lib/base';

interface StartResult {
  registrationId: string;
  channel: 'email' | 'phone';
  sentTo: string;
  viaLogFallback: boolean;
}

export function RegisterPage() {
  const [searchParams] = useSearchParams();
  const requestedNext = safeReturnTo(searchParams.get('next'));
  const returnTo = requestedNext ?? '/';
  const redirect = usePostAuthRedirect(returnTo);
  const bootstrapQ = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api<PortalBootstrap>('/api/portal/bootstrap'),
  });
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [start, setStart] = useState<StartResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();
  const requestedChannel = searchParams.get('channel');
  const phoneRegistrationEnabled = bootstrapQ.data?.registration.phoneRegistrationEnabled ?? false;
  const registrationChannel = requestedChannel === 'email'
    ? 'email'
    : requestedChannel === 'phone' && phoneRegistrationEnabled
      ? 'phone'
      : bootstrapQ.data?.registration.verificationChannel ?? 'email';

  useEffect(() => {
    setStep('form');
    setStart(null);
    form.resetFields();
    form.setFieldValue('inviteCode', searchParams.get('invite') ?? '');
  }, [form, registrationChannel, searchParams]);

  async function onFormFinish(values: {
    username: string;
    password: string;
    email?: string;
    phone?: string;
    inviteCode?: string;
  }): Promise<void> {
    setLoading(true);
    try {
      const powToken = await obtainPowToken();
      const r = await api<StartResult>('/api/auth/register/start', {
        method: 'POST',
        json: { ...values, channel: registrationChannel, powToken },
      });
      setStart(r);
      setStep('code');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '注册失败');
    } finally {
      setLoading(false);
    }
  }

  async function onCodeFinish(values: { code: string }): Promise<void> {
    if (!start) return;
    setLoading(true);
    try {
      const r = await api<{
        mustChangePassword: boolean;
        mustEnrollMfa: boolean;
        user: { membershipSelectionRequired: boolean };
      }>(
        '/api/auth/register/verify',
        { method: 'POST', json: { registrationId: start.registrationId, code: values.code } },
      );
      message.success('注册成功');
      redirect(r);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '验证失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthPanel className="aap-auth-panel--register">
      <Typography.Title level={3} className="aap-auth-title">
        注册账号
      </Typography.Title>
      <Typography.Paragraph className="aap-auth-description">
        创建账号，开始使用并发布你的应用创作。
      </Typography.Paragraph>

      {bootstrapQ.isError ? (
        <Alert type="error" showIcon message="无法读取注册设置，请稍后重试" />
      ) : !bootstrapQ.data ? (
        <Alert type="info" showIcon message="正在读取注册设置…" />
      ) : step === 'form' ? (
        <Form
          form={form}
          layout="vertical"
          onFinish={onFormFinish}
          initialValues={{
            inviteCode: searchParams.get('invite') ?? '',
          }}
        >
          <Form.Item
            name="username"
            label="用户名"
            rules={[
              { required: true, message: '请输入用户名' },
              { pattern: /^[a-z0-9][a-z0-9_.-]{2,63}$/, message: '3-64 位小写字母/数字/_.- ，字母或数字开头' },
            ]}
          >
            <Input placeholder="小写字母与数字" autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[
              { required: true, message: '请输入密码' },
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
          <Form.Item
            name="password2"
            label="确认密码"
            dependencies={['password']}
            rules={[
              { required: true, message: '请再次输入密码' },
              ({ getFieldValue }) => ({
                validator: (_, v) =>
                  !v || v === getFieldValue('password')
                    ? Promise.resolve()
                    : Promise.reject(new Error('两次输入不一致')),
              }),
            ]}
          >
            <Input.Password />
          </Form.Item>
          {registrationChannel === 'phone' ? (
            <Form.Item
              name="phone"
              label="手机号码"
              preserve={false}
              rules={[
                { required: true, message: '请输入手机号码' },
                { pattern: /^1[3-9]\d{9}$/, message: '请输入有效的中国大陆手机号码' },
              ]}
              extra="仅支持中国大陆手机号码，用于接收注册验证码"
            >
              <Input inputMode="tel" maxLength={11} />
            </Form.Item>
          ) : (
            <Form.Item
              name="email"
              label="邮箱"
              preserve={false}
              rules={[
                { required: true, message: '请输入邮箱' },
                { type: 'email', message: '邮箱格式不正确' },
              ]}
              extra="用于接收注册验证码与找回密码"
            >
              <Input />
            </Form.Item>
          )}
          <Form.Item
            name="inviteCode"
            label="邀请码（选填）"
            extra="填写有效邀请码，邀请人可获得奖励积分；无效或已停用的邀请码不影响注册。"
          >
            <Input placeholder="xxxx-xxxx-xxxx-xxxx" maxLength={191} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>
            获取{registrationChannel === 'phone' ? '短信' : '邮箱'}验证码
          </Button>
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <Link
              to={returnTo === '/' && searchParams.get('nonPublicApp') !== '1'
                ? '/login'
                : `/login?${new URLSearchParams({
                    ...(requestedNext ? { next: requestedNext } : {}),
                    ...(searchParams.get('nonPublicApp') === '1' ? { nonPublicApp: '1' } : {}),
                  }).toString()}`}
            >
              已有账号？登录
            </Link>
          </div>
        </Form>
      ) : (
        <>
          <Alert
            type={start?.viaLogFallback ? 'warning' : 'success'}
            showIcon
            style={{ marginBottom: 16 }}
            message={
              start?.viaLogFallback
                ? `邮件服务未配置，验证码已写入服务端日志`
                : `验证码已发送至${start?.channel === 'phone' ? '手机' : '邮箱'} ${start?.sentTo ?? ''}，5 分钟内有效`
            }
          />
          <Form layout="vertical" onFinish={onCodeFinish}>
            <Form.Item name="code" rules={[{ required: true, message: '请输入 6 位验证码' }]}>
              <Input placeholder="6 位验证码" size="large" autoFocus maxLength={6} />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>
              完成注册
            </Button>
          </Form>
        </>
      )}
    </AuthPanel>
  );
}
