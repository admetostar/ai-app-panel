/** 注册页（A2）：始终开放注册；两步注册（资料 → 邮箱验证码）；全程 PoW。 */
import { Alert, Button, Form, Input, Typography, message } from 'antd';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { isPasswordValid, PASSWORD_POLICY_MESSAGE } from '@aap/shared';
import { api } from '../api/client';
import { obtainPowToken } from '../lib/pow';
import { usePostAuthRedirect } from '../state/session';
import { AuthPanel } from '../components/AuthPanel';

interface StartResult {
  registrationId: string;
  sentTo: string;
  viaLogFallback: boolean;
}

export function RegisterPage() {
  const redirect = usePostAuthRedirect();
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [start, setStart] = useState<StartResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  async function onFormFinish(values: {
    username: string;
    password: string;
    email: string;
    inviteCode?: string;
  }): Promise<void> {
    setLoading(true);
    try {
      const powToken = await obtainPowToken();
      const r = await api<StartResult>('/api/auth/register/start', {
        method: 'POST',
        json: { ...values, powToken },
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
    <AuthPanel>
      <Typography.Title level={3} className="aap-auth-title">
        注册账号
      </Typography.Title>
      <Typography.Paragraph className="aap-auth-description">
        创建账号，开始使用并发布你的应用创作。
      </Typography.Paragraph>

      {step === 'form' ? (
        <Form
          form={form}
          layout="vertical"
          onFinish={onFormFinish}
          initialValues={{ inviteCode: searchParams.get('invite') ?? '' }}
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
          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
            extra="用于接收验证码与找回密码"
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="inviteCode"
            label="邀请码（选填）"
            extra="填写有效邀请码，邀请人可获得奖励积分；无效或已停用的邀请码不影响注册。"
          >
            <Input placeholder="xxxx-xxxx-xxxx-xxxx" maxLength={191} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>
            获取邮箱验证码
          </Button>
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <Link to="/login">已有账号？登录</Link>
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
                ? `验证码已发送（服务端未配置 SMTP，验证码在服务端日志中）`
                : `验证码已发送至 ${start?.sentTo ?? ''}，5 分钟内有效`
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
