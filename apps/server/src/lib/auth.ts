/**
 * 鉴权守卫。M1 RBAC 简化为 user.role（admin/user）；
 * M4 细粒度角色如需要再扩表。
 */
import type { RequestHandler } from 'express';
import { audit } from './audit.js';

/** 要求已登录且完成完整认证（authState === 'full'） */
export const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.user) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } });
    return;
  }
  // MFA 待验证的半登录态只能访问 mfa 相关端点（那些端点不用 requireAuth）
  if (req.user.authState !== 'full') {
    res.status(403).json({ error: { code: 'MFA_REQUIRED', message: '需要完成多因子认证', action: 'mfa' } });
    return;
  }
  const requestPath = req.originalUrl.split('?')[0] ?? '';
  const isMembershipSummaryRequest = req.method === 'GET' && requestPath === '/api/user/membership';
  if (
    req.user.membershipSelectionRequired &&
    ![
      '/api/auth/me',
      '/api/auth/logout',
      '/api/user/membership/select-plan',
      '/api/user/membership/skip-selection',
    ].includes(requestPath) &&
    !isMembershipSummaryRequest
  ) {
    res.status(403).json({
      error: { code: 'MEMBERSHIP_SELECTION_REQUIRED', message: '请先选择权益计划', action: 'membership-selection' },
    });
    return;
  }
  next();
};

/** 要求步升认证（敏感操作：改绑邮箱/手机、注销、MFA 管理、恢复码重生成） */
export const requireStepUp: RequestHandler = (req, res, next) => {
  requireAuth(req, res, () => {
    const until = req.user?.stepUpUntil ?? 0;
    if (until <= Date.now()) {
      res.status(403).json({ error: { code: 'STEP_UP_REQUIRED', message: '该操作需要重新验证一次身份因子', action: 'step-up' } });
      return;
    }
    next();
  });
};

/** 要求管理员 */
export const requireAdmin: RequestHandler = (req, res, next) => {
  requireAuth(req, res, async () => {
    if (req.user?.role !== 'admin') {
      await audit(req.user ? `${req.user.kind}:${req.user.id}` : 'anonymous', req.clientIp ?? null, 'admin.denied', {
        path: req.path,
      });
      res.status(403).json({ error: { code: 'FORBIDDEN', message: '需要管理员权限' } });
      return;
    }
    next();
  });
};
