import { Alert, Anchor, Button, Center, Paper, PasswordInput, PinInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

export function LoginPage() {
  const [stage, setStage] = useState<'password' | 'mfa'>('password');
  const [email, setEmail] = useState('admin@complao.com');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const next = params.get('next')?.startsWith('/') ? params.get('next')! : '/actions';

  const finish = async () => {
    await qc.invalidateQueries();
    navigate(next, { replace: true });
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ next: 'mfa' | 'done' }>('/auth/login', { method: 'POST', json: { email, password } });
      if (r.next === 'done') await finish();
      else setStage('mfa');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/mfa', { method: 'POST', json: { code: value } });
      await finish();
    } catch (err) {
      setCode('');
      if (err instanceof ApiError && err.message === 'Sign in again.') {
        setStage('password');
        setPassword('');
        setError('The sign-in took too long. Enter your password again.');
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center mih="100vh" p="md" style={{ background: 'var(--paper)' }}>
      <Paper w={380} p="xl" radius="lg" shadow="xs">
        <Stack gap="lg">
          <Stack gap={6}>
            <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden>
              <rect width="32" height="32" rx="7" fill="#17233F" />
              <path d="M9 10h6M12 16h11M12 22h7" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
              <path d="M9 10v12" stroke="#2F5BEA" strokeWidth="2.6" strokeLinecap="round" />
            </svg>
            <Title order={1} fz={22}>
              Complao action log
            </Title>
            <Text size="sm" c="dimmed">
              {stage === 'password' ? 'Sign in with the shared admin account.' : 'Enter the 6-digit code from your authenticator app.'}
            </Text>
          </Stack>

          {error && (
            <Alert color="red" variant="light" py="xs">
              {error}
            </Alert>
          )}

          {stage === 'password' ? (
            <form onSubmit={submitPassword}>
              <Stack gap="sm">
                <TextInput label="Email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} autoComplete="username" required />
                <PasswordInput label="Password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" required autoFocus />
                <Button type="submit" loading={busy} mt="xs">
                  Continue
                </Button>
              </Stack>
            </form>
          ) : (
            <Stack gap="md" align="center">
              <PinInput length={6} type="number" oneTimeCode autoFocus value={code} onChange={setCode} onComplete={submitCode} disabled={busy} aria-label="Authenticator code" size="md" />
              <Anchor component="button" size="sm" onClick={() => setStage('password')}>
                Use a different account
              </Anchor>
            </Stack>
          )}
        </Stack>
      </Paper>
    </Center>
  );
}
