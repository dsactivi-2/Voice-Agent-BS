import { useState } from 'react';
import { Button, Stack, CircularProgress } from '@mui/material';
import { useNotify, useRefresh } from 'react-admin';
import type { CampaignStatus } from '../types';
import { STATUS_TRANSITIONS } from '../types';
import { setCampaignStatus } from '../services/api';
import { CAMPAIGN_STATUS_COLORS, STATUS_TRANSITION_LABELS } from '../theme';

interface StatusTransitionButtonsProps {
  campaignId: string;
  currentStatus: CampaignStatus;
}

export function StatusTransitionButtons({
  campaignId,
  currentStatus,
}: StatusTransitionButtonsProps) {
  const notify = useNotify();
  const refresh = useRefresh();
  const [loading, setLoading] = useState<CampaignStatus | null>(null);

  const targets = STATUS_TRANSITIONS[currentStatus] ?? [];

  if (targets.length === 0) return null;

  const handleTransition = async (target: CampaignStatus) => {
    setLoading(target);
    try {
      await setCampaignStatus(campaignId, target);
      notify(`Status geändert zu ${target}`, { type: 'success' });
      refresh();
    } catch {
      notify('Status-Änderung fehlgeschlagen', { type: 'error' });
    } finally {
      setLoading(null);
    }
  };

  return (
    <Stack direction="row" spacing={0.5} data-testid="status-transition-buttons">
      {targets.map((target) => {
        const colors = CAMPAIGN_STATUS_COLORS[target];
        return (
          <Button
            key={target}
            size="small"
            variant="contained"
            disabled={loading !== null}
            data-testid={`transition-btn-${target}`}
            onClick={() => void handleTransition(target)}
            sx={{
              backgroundColor: colors.bg,
              color: colors.text,
              '&:hover': { backgroundColor: colors.bg, opacity: 0.85 },
              fontSize: '0.7rem',
              py: 0.25,
              px: 1,
            }}
          >
            {loading === target ? (
              <CircularProgress size={12} sx={{ color: '#fff' }} />
            ) : (
              STATUS_TRANSITION_LABELS[target]
            )}
          </Button>
        );
      })}
    </Stack>
  );
}
