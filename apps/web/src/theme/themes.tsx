/**
 * 主题系统保留内置色板，门户全局默认使用石墨暗色；个人中心与我的应用可在页面会话内覆盖：
 * 主题 = 一组 design token（CSS variables + AntD token 双写），
 * CSS 变量和 AntD token 由同一套颜色定义生成。
 * TS 是单一来源；CSS 变量由 ThemeProvider 写入 :root，自定义样式消费。
 */
import { ConfigProvider, theme as antdTheme, type ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useEffect, useMemo, type ReactNode } from 'react';
import type { BuiltinThemeId } from '@aap/shared';

export interface AapThemeColors {
  primary: string;
  accent: string;
  bgLayout: string;
  bgContainer: string;
  bgElevated: string;
  text: string;
  textSecondary: string;
  border: string;
}

export interface AapTheme {
  id: BuiltinThemeId;
  name: string;
  dark: boolean;
  colors: AapThemeColors;
}

export const BUILTIN_THEMES: AapTheme[] = [
  {
    id: 'ocean',
    name: '海雾蓝',
    dark: false,
    colors: {
      primary: '#1E5AA8',
      accent: '#13C2C2',
      bgLayout: '#F2F6FB',
      bgContainer: '#FFFFFF',
      bgElevated: '#FFFFFF',
      text: '#17233D',
      textSecondary: '#5A6A85',
      border: '#D8E1EC',
    },
  },
  {
    id: 'aurora',
    name: '极光青',
    dark: false,
    colors: {
      primary: '#0E9F8A',
      accent: '#7B61FF',
      bgLayout: '#F0FAF8',
      bgContainer: '#FFFFFF',
      bgElevated: '#FFFFFF',
      text: '#10322D',
      textSecondary: '#557A73',
      border: '#CFE8E2',
    },
  },
  {
    id: 'forest',
    name: '松林绿',
    dark: false,
    colors: {
      primary: '#2E7D32',
      accent: '#F5A623',
      bgLayout: '#F4FAF3',
      bgContainer: '#FFFFFF',
      bgElevated: '#FFFFFF',
      text: '#1B2E1C',
      textSecondary: '#5C735E',
      border: '#D3E4D4',
    },
  },
  {
    id: 'sunset',
    name: '暖阳橙',
    dark: false,
    colors: {
      primary: '#D46B08',
      accent: '#1677FF',
      bgLayout: '#FDF6EF',
      bgContainer: '#FFFFFF',
      bgElevated: '#FFFFFF',
      text: '#3D2B1F',
      textSecondary: '#8C6F5C',
      border: '#F0DECB',
    },
  },
  {
    id: 'sakura',
    name: '樱粉',
    dark: false,
    colors: {
      primary: '#C2477E',
      accent: '#531DAB',
      bgLayout: '#FBF3F7',
      bgContainer: '#FFFFFF',
      bgElevated: '#FFFFFF',
      text: '#33182A',
      textSecondary: '#8A5F77',
      border: '#F0D6E3',
    },
  },
  {
    id: 'graphite',
    name: '石墨（暗色）',
    dark: true,
    colors: {
      primary: '#4C8DFF',
      accent: '#36CFC9',
      bgLayout: '#14171C',
      bgContainer: '#1D2129',
      bgElevated: '#23272F',
      text: '#E6E8EC',
      textSecondary: '#9AA3B2',
      border: '#2E333D',
    },
  },
];

export function getTheme(id: string | null | undefined): AapTheme {
  return BUILTIN_THEMES.find((t) => t.id === id) ?? BUILTIN_THEMES.find((t) => t.id === 'graphite')!;
}

function cssVarName(k: keyof AapThemeColors): string {
  return `--aap-${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`;
}

function applyCssVars(theme: AapTheme, accent: string | null): void {
  const root = document.documentElement;
  const colors = accent ? { ...theme.colors, accent } : theme.colors;
  for (const [k, v] of Object.entries(colors)) {
    root.style.setProperty(cssVarName(k as keyof AapThemeColors), v);
  }
  root.dataset.aapTheme = theme.id;
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const theme = getTheme('graphite');

  useEffect(() => {
    localStorage.removeItem('aap.theme');
    localStorage.removeItem('aap.accent');
    applyCssVars(theme, null);
  }, [theme]);

  const antdConfig = useMemo<ThemeConfig>(() => {
    const primary = theme.colors.primary;
    return {
      algorithm: theme.dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: primary,
        colorInfo: primary,
        colorBgLayout: theme.colors.bgLayout,
        colorBgContainer: theme.colors.bgContainer,
        colorBgElevated: theme.colors.bgElevated,
        colorText: theme.colors.text,
        colorTextSecondary: theme.colors.textSecondary,
        colorBorder: theme.colors.border,
        colorBorderSecondary: theme.colors.border,
        borderRadius: 8,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
      },
    };
  }, [theme]);

  return (
    <ConfigProvider locale={zhCN} theme={antdConfig}>
      {children}
    </ConfigProvider>
  );
}
