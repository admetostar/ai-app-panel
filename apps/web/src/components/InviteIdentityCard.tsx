import { Spin, message } from 'antd';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { withBase } from '../lib/base';

interface InviteInfo {
  code: string;
  useCount: number;
}

export function InviteIdentityCard({
  open,
  siteName,
  logo,
  userName,
  theme,
}: {
  open: boolean;
  siteName: string;
  logo: string | null;
  userName: string;
  theme: 'light' | 'dark';
}) {
  const invite = useQuery({
    queryKey: ['user-invite'],
    queryFn: () => api<InviteInfo>('/api/user/invite'),
    enabled: open,
    retry: false,
  });
  const [qr, setQr] = useState<string | null>(null);
  const inviteLink = useMemo(
    () => invite.data ? `${window.location.origin}${withBase('/register')}?channel=email&invite=${encodeURIComponent(invite.data.code)}` : '',
    [invite.data],
  );

  useEffect(() => {
    if (!open || !inviteLink) {
      setQr(null);
      return;
    }
    let active = true;
    void QRCode.toDataURL(inviteLink, {
      margin: 1,
      width: 240,
      color: { dark: '#111820', light: '#F7F5EF' },
    }).then((dataUrl) => {
      if (active) setQr(dataUrl);
    }).catch((error: unknown) => {
      if (!active) return;
      setQr(null);
      message.error(error instanceof Error ? `邀请码二维码生成失败：${error.message}` : '邀请码二维码生成失败');
    });
    return () => {
      active = false;
    };
  }, [inviteLink, open]);

  async function copyInviteLink(): Promise<void> {
    if (invite.isError) {
      const result = await invite.refetch();
      if (result.isError) {
        message.error(result.error instanceof Error ? `邀请码加载失败：${result.error.message}` : '邀请码加载失败');
      }
      return;
    }
    if (!inviteLink) {
      message.info('邀请码正在加载，请稍后重试');
      return;
    }

    let clipboardError: unknown;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('浏览器剪贴板 API 不可用');
      await navigator.clipboard.writeText(inviteLink);
      message.success('邀请注册链接已复制');
      return;
    } catch (error) {
      clipboardError = error;
    }

    const textarea = document.createElement('textarea');
    textarea.value = inviteLink;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    try {
      if (!document.execCommand('copy')) throw new Error('浏览器拒绝复制操作');
      message.success('邀请注册链接已复制');
    } catch (fallbackError) {
      const details = [clipboardError, fallbackError]
        .filter((error): error is Error => error instanceof Error)
        .map((error) => error.message)
        .join('；');
      message.error(`复制失败：${details || '请检查浏览器剪贴板权限'}`);
    } finally {
      textarea.remove();
    }
  }

  return (
    <button
      type="button"
      className={`aap-id-card aap-id-card--${theme}`}
      aria-label="点击复制邀请链接"
      title="点击复制邀请链接"
      onClick={(event) => {
        event.stopPropagation();
        void copyInviteLink();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <span className="aap-id-card__details">
        <span className="aap-id-card__brand">
          {logo ? (
            <img src={logo} alt="" />
          ) : (
            <span className="aap-id-card__mark" aria-hidden="true">{siteName[0] ?? 'A'}</span>
          )}
          <span className="aap-id-card__site-name">{siteName}</span>
        </span>
        <span className="aap-id-card__owner">{userName}</span>
        <span className="aap-id-card__invite-label">专属邀请码</span>
        <span className="aap-id-card__invite-code">
          {invite.data?.code ?? (invite.isError ? '邀请码暂不可用' : '正在加载邀请码…')}
        </span>
      </span>
      <span className="aap-id-card__qr-panel">
        <span className="aap-id-card__qr">
          {invite.isLoading || !invite.data || !qr ? <Spin size="small" /> : (
            <img src={qr} alt="" />
          )}
        </span>
        <strong>扫码注册</strong>
        <span>已邀请 {invite.data?.useCount ?? 0} 个账号</span>
      </span>
    </button>
  );
}
