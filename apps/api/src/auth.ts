import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response, Router } from 'express';
import express from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { authenticator } from 'otplib';
import { z } from 'zod';
import type { Env } from './env';

/**
 * R13: one login, admin@complao.com, with multi-factor authentication.
 * Step 1 checks the password and issues a 5-minute "mfa pending" cookie.
 * Step 2 checks the TOTP code and issues the session cookie. Every other /api route
 * requires that session.
 */
const SESSION_COOKIE = 'clp_session';
const PENDING_COOKIE = 'clp_mfa';

authenticator.options = { window: 1 };

export function authRouter(env: Env): { router: Router; requireSession: (req: Request, res: Response, next: NextFunction) => void } {
  const key = new TextEncoder().encode(env.sessionSecret || 'dev-only-not-used-when-auth-enabled-000');
  const router = express.Router();
  const limiter = attemptLimiter(10, 15 * 60_000);
  const usedCodes = new Map<string, number>(); // replay protection for TOTP codes

  const cookieOpts = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: env.production,
    path: '/',
  };

  async function sign(stage: 'mfa' | 'session', ttlSeconds: number) {
    return new SignJWT({ stage, sub: env.adminEmail })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(key);
  }

  async function verify(token: string | undefined, stage: 'mfa' | 'session') {
    if (!token) return false;
    try {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
      return payload.stage === stage && payload.sub === env.adminEmail;
    } catch {
      return false;
    }
  }

  router.post('/login', async (req, res) => {
    if (env.authDisabled) return res.json({ next: 'done' });
    const ip = req.ip ?? 'unknown';
    if (!limiter.allow(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const body = z.object({ email: z.string(), password: z.string() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Email and password are required.' });
    const emailOk = body.data.email.trim().toLowerCase() === env.adminEmail;
    const passOk = await bcrypt.compare(body.data.password, env.adminPasswordHash);
    if (!emailOk || !passOk) {
      limiter.fail(ip);
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    res.cookie(PENDING_COOKIE, await sign('mfa', 300), { ...cookieOpts, maxAge: 300_000 });
    res.json({ next: 'mfa' });
  });

  router.post('/mfa', async (req, res) => {
    if (env.authDisabled) return res.json({ ok: true });
    const ip = req.ip ?? 'unknown';
    if (!limiter.allow(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    if (!(await verify(req.cookies?.[PENDING_COOKIE], 'mfa'))) return res.status(401).json({ error: 'Sign in again.', restart: true });
    const code = String(req.body?.code ?? '').replace(/\s/g, '');
    const now = Date.now();
    for (const [c, t] of usedCodes) if (now - t > 120_000) usedCodes.delete(c);
    if (!/^\d{6}$/.test(code) || usedCodes.has(code) || !authenticator.verify({ token: code, secret: env.totpSecret })) {
      limiter.fail(ip);
      return res.status(401).json({ error: 'That code is not valid.' });
    }
    usedCodes.set(code, now);
    res.clearCookie(PENDING_COOKIE, cookieOpts);
    res.cookie(SESSION_COOKIE, await sign('session', env.sessionHours * 3600), { ...cookieOpts, maxAge: env.sessionHours * 3_600_000 });
    res.json({ ok: true });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieOpts);
    res.clearCookie(PENDING_COOKIE, cookieOpts);
    res.json({ ok: true });
  });

  router.get('/me', async (req, res) => {
    if (env.authDisabled) return res.json({ email: env.adminEmail, authDisabled: true });
    if (!(await verify(req.cookies?.[SESSION_COOKIE], 'session'))) return res.status(401).json({ error: 'Not signed in' });
    res.json({ email: env.adminEmail });
  });

  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    if (env.authDisabled) return next();
    verify(req.cookies?.[SESSION_COOKIE], 'session').then((ok) => (ok ? next() : res.status(401).json({ error: 'Not signed in' })));
  };

  return { router, requireSession };
}

function attemptLimiter(max: number, windowMs: number) {
  const fails = new Map<string, number[]>();
  return {
    allow(ip: string) {
      const now = Date.now();
      const list = (fails.get(ip) ?? []).filter((t) => now - t < windowMs);
      fails.set(ip, list);
      return list.length < max;
    },
    fail(ip: string) {
      const list = fails.get(ip) ?? [];
      list.push(Date.now());
      fails.set(ip, list);
    },
  };
}
