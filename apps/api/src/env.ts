export interface Env {
  port: number;
  store: 'dynamo' | 'memory';
  tableName: string;
  dynamoEndpoint?: string;
  demo: boolean;
  authDisabled: boolean;
  adminEmail: string;
  adminPasswordHash: string;
  totpSecret: string;
  sessionSecret: string;
  sessionHours: number;
  userLookupUrl?: string;
  userLookupToken?: string;
  production: boolean;
  webDist?: string;
}

export function loadEnv(e: NodeJS.ProcessEnv = process.env): Env {
  const production = e.NODE_ENV === 'production';
  const env: Env = {
    port: Number(e.PORT ?? 8787),
    store: e.STORE === 'memory' ? 'memory' : 'dynamo',
    tableName: e.TABLE_NAME ?? 'complao-action-log',
    dynamoEndpoint: e.DYNAMODB_ENDPOINT || undefined,
    demo: e.DEMO === '1',
    authDisabled: e.AUTH_DISABLED === '1',
    adminEmail: (e.ADMIN_EMAIL ?? 'admin@complao.com').toLowerCase(),
    adminPasswordHash: e.ADMIN_PASSWORD_HASH ?? '',
    totpSecret: e.ADMIN_TOTP_SECRET ?? '',
    sessionSecret: e.SESSION_SECRET ?? '',
    sessionHours: Number(e.SESSION_HOURS ?? 12),
    userLookupUrl: e.USER_LOOKUP_URL || undefined,
    userLookupToken: e.USER_LOOKUP_TOKEN || undefined,
    production,
    webDist: e.WEB_DIST || undefined,
  };

  if (env.authDisabled && production) throw new Error('AUTH_DISABLED is not allowed when NODE_ENV=production (R13)');
  if (!env.authDisabled) {
    const missing = [
      !env.adminPasswordHash && 'ADMIN_PASSWORD_HASH',
      !env.totpSecret && 'ADMIN_TOTP_SECRET',
      env.sessionSecret.length < 32 && 'SESSION_SECRET (32+ chars)',
    ].filter(Boolean);
    if (missing.length) throw new Error(`Missing auth settings: ${missing.join(', ')}. Run "npm run setup:admin" to generate them.`);
  }
  return env;
}
