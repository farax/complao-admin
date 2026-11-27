import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@mantine/core/styles.layer.css';
import '@mantine/dates/styles.layer.css';
import '@mantine/charts/styles.layer.css';
import '@mantine/notifications/styles.layer.css';
import 'mantine-datatable/styles.layer.css';
import './styles.css';

import { MantineProvider } from '@mantine/core';
import { DatesProvider } from '@mantine/dates';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import 'dayjs/locale/en-au';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, createMemoryRouter, Navigate, RouterProvider, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { api, LOCAL_DEMO } from './lib/api';
import { BootScreen } from './demo/BootScreen';
import { ActionDetailPage } from './pages/ActionDetail';
import { ActionsPage } from './pages/Actions';
import { HealthPage } from './pages/Health';
import { JourneyPage } from './pages/Journey';
import { LivePage } from './pages/Live';
import { SessionDetailPage } from './pages/SessionDetail';
import { LoginPage } from './pages/Login';
import { LogsPage } from './pages/Logs';
import { SettingsPage } from './pages/Settings';
import { theme } from './theme';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (n, e) => n < 2 && (e as { status?: number }).status !== 401 && (e as { status?: number }).status !== 404, refetchOnWindowFocus: true } },
});

/** R13: nothing renders behind the login without a session. */
function RequireSession({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ email: string }>('/auth/me'), retry: false, staleTime: 60_000 });
  if (me.isLoading) return null;
  if (me.isError) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

// The static preview runs inside a sandboxed frame, so it keeps its route in memory.
const router = (LOCAL_DEMO ? (r: Parameters<typeof createMemoryRouter>[0]) => createMemoryRouter(r, { initialEntries: ['/live'] }) : createBrowserRouter)([
  { path: '/login', element: <LoginPage /> },
  {
    element: (
      <RequireSession>
        <Layout />
      </RequireSession>
    ),
    children: [
      { index: true, element: <Navigate to="/live" replace /> },
      { path: '/live', element: <LivePage /> },
      { path: '/sessions', element: <Navigate to="/live" replace /> },
      { path: '/sessions/:id', element: <SessionDetailPage /> },
      { path: '/actions', element: <ActionsPage /> },
      { path: '/actions/:id', element: <ActionDetailPage /> },
      { path: '/cases/:caseId', element: <JourneyPage /> },
      { path: '/health', element: <HealthPage /> },
      { path: '/logs', element: <LogsPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '*', element: <Navigate to="/live" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <DatesProvider settings={{ locale: 'en-au', firstDayOfWeek: 1 }}>
        <Notifications position="top-right" />
        <QueryClientProvider client={queryClient}>
          {LOCAL_DEMO ? (
            <BootScreen>
              <RouterProvider router={router} />
            </BootScreen>
          ) : (
            <RouterProvider router={router} />
          )}
        </QueryClientProvider>
      </DatesProvider>
    </MantineProvider>
  </StrictMode>,
);
