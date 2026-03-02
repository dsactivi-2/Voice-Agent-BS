import { Chip } from '@mui/material';
import type { CampaignStatus } from '../types';
import { CAMPAIGN_STATUS_COLORS } from '../theme';

interface StatusChipProps {
  status: CampaignStatus;
}

export function StatusChip({ status }: StatusChipProps) {
  const colors = CAMPAIGN_STATUS_COLORS[status] ?? { bg: '#757575', text: '#fff' };
  return (
    <Chip
      label={status.toUpperCase()}
      size="small"
      data-testid={`status-chip-${status}`}
      sx={{
        backgroundColor: colors.bg,
        color: colors.text,
        fontWeight: 700,
        fontSize: '0.7rem',
        letterSpacing: '0.05em',
      }}
    />
  );
}
