/** 找回密码：邮箱或已绑定手机号 + 验证码重置。 */
import { Alert, Button, Form, Input, Segmented, Typography, message } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { obtainPowToken } from '../lib/pow';
import { isPasswordValid, PASSWORD_POLICY_MESSAGE } from '@aap/shared';
import { AuthPanel } from '../components/AuthPanel';

type RecoveryChannel = 'email' | 'phone';

export function ForgotPage() {
  const [channel, setChannel] = useState<RecoveryChannel>('email');
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState('');
  const [unmatchedPhone, setUnmatchedPhone] = useState(false);

  async function onStart(values: { target: string }): Promise<void> {
    setLoading(true);
    setTarget(values.target);
    setUnmatchedPhone(false);
    try {
      const powToken = await obtainPowToken();
      const result = await api<{ matched?: boolean }>('/api/auth/forgot/start', {
        method: 'POST',
        json: { channel, target: values.target, powToken },
      });
      if (channel === 'phone' && result.matched === false) {
        setUnmatchedPhone(true);
        return;
      }
      setSent(true);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '发送失败');
    } finally {
      setLoading(false);
    }
  }

  async function onReset(values: { code: string; newPassword: string }): Promise<void> {
    setLoading(true);
    try {
      await api('/api/auth/forgot/verify', {
        method: 'POST',
        json: { channel, target, code: values.code, newPassword: values.newPassword },
      });
      setDone(true);
      message.success('密码已重置，请用新密码登录');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '重置失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthPanel className="aap-auth-panel--forgot">
      <Typography.Title level={3} className="aap-auth-title">
        找回密码
      </Typography.Title>
      <Typography.Paragraph className="aap-auth-description">
        通过注册邮箱或已绑定手机号重置密码。
      </Typography.Paragraph>

      {done ? (
        <>
          <Alert type="success" showIcon style={{ marginBottom: 16 }} message="密码已重置，请返回登录" />
          <div style={{ textAlign: 'center' }}>
            <Link to="/login">返回登录</Link>
          </div>
        </>
      ) : !sent ? (
        <Form key={channel} layout="vertical" onFinish={onStart}>
          <Form.Item label="找回方式">
            <Segmented
              block
              value={channel}
              options={[
                { label: '注册邮箱', value: 'email' },
                { label: '手机号', value: 'phone' },
              ]}
              onChange={(value) => {
                setChannel(value === 'phone' ? 'phone' : 'email');
                setUnmatchedPhone(false);
              }}
            />
          </Form.Item>
          {unmatchedPhone ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="未匹配到账号，请检查手机号码输入正确。"
            />
          ) : null}
          <Form.Item
            name="target"
            label={channel === 'email' ? '注册邮箱' : '已绑定手机号'}
            rules={channel === 'email'
              ? [{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]
              : [{ required: true, message: '请输入手机号' }, { pattern: /^1[3-9]\d{9}$/, message: '请输入有效的中国大陆手机号码' }]}
          >
            <Input
              autoFocus
              inputMode={channel === 'phone' ? 'tel' : 'email'}
              maxLength={channel === 'phone' ? 11 : undefined}
              placeholder={channel === 'email' ? '请输入注册邮箱' : '请输入已绑定的手机号'}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block size="large">
            发送{channel === 'phone' ? '短信' : '邮箱'}验证码
          </Button>
          <div style={{ marginTop: 16, textAlign: 'center' }}>
            <Link to="/login">返回登录</Link>
          </div>
        </Form>
      ) : (
        <>
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 16 }}
            message={channel === 'phone'
              ? '短信验证码已发送至手机（5 分钟有效）'
              : '若该邮箱已绑定本地账号，验证码将发送至邮箱（5 分钟有效）'}
          />
          <Form layout="vertical" onFinish={onReset}>
            <Form.Item name="code" label="验证码" rules={[{ required: true, message: '请输入验证码' }]}>
              <Input maxLength={6} autoFocus />
            </Form.Item>
            <Form.Item
              name="newPassword"
              label="新密码"
              rules={[
                { required: true, message: '请输入新密码' },
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
            <Button type="primary" htmlType="submit" loading={loading} block size="large">
              重置密码
            </Button>
          </Form>
        </>
      )}
    </AuthPanel>
  );
}
