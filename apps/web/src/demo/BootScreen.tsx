import { Center, Loader, Stack, Text } from '@mantine/core';
import { useEffect, useState, type ReactNode } from 'react';

/** Waits while the in-page demo builds a week of simulated history. */
export function BootScreen({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    import('./local-api').then((m) => m.boot()).then(() => setReady(true));
  }, []);
  if (ready) return <>{children}</>;
  return (
    <Center mih="100vh">
      <Stack align="center" gap="sm">
        <Loader />
        <Text size="sm" c="dimmed">
          Building a week of simulated Complao traffic…
        </Text>
      </Stack>
    </Center>
  );
}
