import { Button, Drawer, Group } from '@mantine/core';
import { IconExternalLink, IconRoute, IconUser } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { ActionDetailBody } from '../pages/ActionDetail';

/** Drill into one action without leaving Live, Sessions or a journey. */
export function ActionDrawer({
  actionId,
  sessionId,
  caseId,
  onClose,
}: {
  actionId: string | null;
  sessionId?: string | null;
  caseId?: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  return (
    <Drawer opened={Boolean(actionId)} onClose={onClose} position="right" size="min(980px, 92vw)" title="Action" padding="lg">
      {actionId && (
        <>
          <Group gap="xs" mb="md">
            <Button size="xs" variant="light" leftSection={<IconExternalLink size={14} />} onClick={() => navigate(`/actions/${actionId}`)}>
              Open full page
            </Button>
            {sessionId && (
              <Button size="xs" variant="default" leftSection={<IconUser size={14} />} onClick={() => navigate(`/sessions/${encodeURIComponent(sessionId)}`)}>
                Open this person’s session
              </Button>
            )}
            {caseId && (
              <Button size="xs" variant="default" leftSection={<IconRoute size={14} />} onClick={() => navigate(`/cases/${encodeURIComponent(caseId)}`)}>
                Open the case journey
              </Button>
            )}
          </Group>
          <ActionDetailBody id={actionId} compact />
        </>
      )}
    </Drawer>
  );
}
