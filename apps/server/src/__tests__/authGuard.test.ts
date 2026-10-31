import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { requireAuth } from '../lib/auth.js';

function runMembershipGate(method: string, originalUrl: string) {
  const req = {
    method,
    originalUrl,
    user: { authState: 'full', membershipSelectionRequired: true },
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
  const next = vi.fn();

  requireAuth(req, res, next);
  return { res, next };
}

describe('membership selection auth gate', () => {
  it('allows reading membership balance while selection is required', () => {
    const { next, res } = runMembershipGate('GET', '/api/user/membership');

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('keeps other account endpoints blocked until plan selection', () => {
    const { next, res } = runMembershipGate('GET', '/api/user/profile');

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows completing or skipping initial plan selection', () => {
    for (const path of ['/api/user/membership/select-plan', '/api/user/membership/skip-selection']) {
      const { next, res } = runMembershipGate('POST', path);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    }
  });
});
