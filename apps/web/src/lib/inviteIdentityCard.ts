import QRCode from 'qrcode';
import { withBase } from './base';

export interface InviteIdentityCardData {
  siteName: string;
  logo: string | null;
  userName: string;
  code: string;
  useCount: number;
  verificationChannel: 'email' | 'phone';
  theme: 'light' | 'dark';
}

export function buildInviteRegistrationUrl(
  code: string,
  verificationChannel: InviteIdentityCardData['verificationChannel'],
): string {
  return `${window.location.origin}${withBase('/register')}?channel=${verificationChannel}&invite=${encodeURIComponent(code)}`;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('品牌 Logo 加载失败'));
    image.src = src;
  });
}

export async function downloadInviteIdentityCard(data: InviteIdentityCardData): Promise<void> {
  const width = 1200;
  const height = 560;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持生成图片');

  const dark = data.theme === 'dark';
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, dark ? '#111820' : '#f8fafc');
  background.addColorStop(1, dark ? '#202a32' : '#e8eef5');
  roundedRect(context, 0, 0, width, height, 36);
  context.fillStyle = background;
  context.fill();

  const foreground = dark ? '#f7f5ef' : '#182230';
  const secondary = dark ? 'rgba(247,245,239,0.68)' : '#667085';
  const gold = dark ? '#f3cc6d' : '#9a6b0b';
  const panelX = 860;
  context.save();
  context.beginPath();
  context.moveTo(panelX, 0);
  context.lineTo(width - 36, 0);
  context.quadraticCurveTo(width, 0, width, 36);
  context.lineTo(width, height - 36);
  context.quadraticCurveTo(width, height, width - 36, height);
  context.lineTo(panelX, height);
  context.closePath();
  context.clip();
  context.fillStyle = dark ? 'rgba(4,8,12,0.3)' : 'rgba(16,24,40,0.045)';
  context.fillRect(panelX, 0, width - panelX, height);
  context.restore();

  if (data.logo) {
    const logoSrc = new URL(data.logo, window.location.origin).href;
    const logo = await loadImage(logoSrc);
    context.save();
    roundedRect(context, 76, 65, 58, 58, 15);
    context.clip();
    context.drawImage(logo, 76, 65, 58, 58);
    context.restore();
  } else {
    context.fillStyle = gold;
    roundedRect(context, 76, 65, 58, 58, 15);
    context.fill();
    context.fillStyle = dark ? '#111820' : '#fff';
    context.font = '700 32px Georgia, serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(data.siteName[0] ?? 'A', 105, 94);
  }

  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillStyle = gold;
  context.font = '600 27px "Microsoft YaHei", sans-serif';
  context.fillText(data.siteName, 154, 103, 640);

  context.fillStyle = secondary;
  context.font = '22px "Microsoft YaHei", sans-serif';
  context.fillText('账号电子身份卡', 76, 208);
  context.fillStyle = foreground;
  context.font = '700 50px "Microsoft YaHei", sans-serif';
  context.fillText(data.userName, 76, 278, 700);
  context.fillStyle = secondary;
  context.font = '22px "Microsoft YaHei", sans-serif';
  context.fillText('专属注册邀请码', 76, 355);
  context.fillStyle = gold;
  context.font = '700 35px ui-monospace, Consolas, monospace';
  context.fillText(data.code, 76, 406, 720);
  context.fillStyle = secondary;
  context.font = '18px "Microsoft YaHei", sans-serif';
  context.fillText('分享邀请链接，邀请朋友加入本站', 76, 455);

  const inviteUrl = buildInviteRegistrationUrl(data.code, data.verificationChannel);
  const qrUrl = await QRCode.toDataURL(inviteUrl, {
    margin: 1,
    width: 280,
    color: { dark: '#111820', light: '#F7F5EF' },
  });
  const qr = await loadImage(qrUrl);
  const qrBox = 250;
  const qrX = panelX + (width - panelX - qrBox) / 2;
  const qrY = 98;
  context.fillStyle = '#f7f5ef';
  roundedRect(context, qrX - 12, qrY - 12, qrBox + 24, qrBox + 24, 22);
  context.fill();
  context.drawImage(qr, qrX, qrY, qrBox, qrBox);
  context.textAlign = 'center';
  context.fillStyle = foreground;
  context.font = '700 25px "Microsoft YaHei", sans-serif';
  context.fillText('扫码注册', panelX + (width - panelX) / 2, 414);
  context.fillStyle = secondary;
  context.font = '19px "Microsoft YaHei", sans-serif';
  context.fillText(`已邀请 ${data.useCount} 个账号`, panelX + (width - panelX) / 2, 451);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error('电子卡图片生成失败'));
    }, 'image/png');
  });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = 'invite-identity-card.png';
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}
