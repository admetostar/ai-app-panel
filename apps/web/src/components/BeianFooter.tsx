import type { BrandingInfo } from '@aap/shared';

/** 项目主页（页脚未配置文案时的默认署名链接） */
const PROJECT_URL = 'https://github.com/admetostar/ai-app-panel';

/** 页脚：主页显示举报邮箱，并展示站点署名与备案信息。 */
export function BeianFooter({ branding, isHome = false }: { branding: BrandingInfo; isHome?: boolean }) {
  const year = new Date().getFullYear();
  const icp = branding.icpNumber?.trim();
  const police = branding.policeNumber?.trim();
  const policeDigits = police ? police.replace(/\D/g, '') : '';
  const copyright = branding.footerCopyright?.trim();
  // 页脚文案已配置 → 首行展示文案 + 备案号；未配置 → 不渲染首行，
  // 仅保留一行「© 年份 站点名」，且未配置时站点名链接到项目主页（默认署名）。
  const configured = Boolean(branding.footerText?.trim());
  const hasFirstLine = configured || Boolean(icp) || Boolean(police);
  return (
    <footer className="aap-footer">
      <div className="aap-footer__inner">
        {isHome && branding.reportEmail ? (
          <div>
            站内违法和不良信息举报邮箱：
            <a href={`mailto:${branding.reportEmail}`}>{branding.reportEmail}</a>
          </div>
        ) : null}
        {hasFirstLine ? (
          <div style={{ marginTop: isHome && branding.reportEmail ? 4 : 0 }}>
            {configured ? <span>{branding.footerText}</span> : null}
            {configured && (icp || police) ? <span> · </span> : null}
            {icp ? (
              <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer noopener">
                {icp}
              </a>
            ) : null}
            {icp && police ? <span> · </span> : null}
            {police && policeDigits ? (
              <a
                href={`https://beian.mps.gov.cn/#/query/webSearch?code=${encodeURIComponent(policeDigits)}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                <span style={{ marginRight: 4 }}>🛡</span>
                {police}
              </a>
            ) : null}
          </div>
        ) : null}
        <div style={{ marginTop: hasFirstLine ? 4 : 0 }}>
          {copyright || (
            <>
              © {year}{' '}
              {configured ? (
                <span>{branding.siteName}</span>
              ) : (
                <a href={PROJECT_URL} target="_blank" rel="noreferrer noopener">
                  {branding.siteName}
                </a>
              )}
            </>
          )}
        </div>
      </div>
    </footer>
  );
}
