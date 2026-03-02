import {
  Edit,
  SimpleForm,
  TextInput,
  SelectInput,
  NumberInput,
  useRecordContext,
  required,
  minValue,
  maxValue,
} from 'react-admin';
import { Alert, Box } from '@mui/material';
import type { Campaign } from '../../types';

function LockedBanner() {
  const record = useRecordContext<Campaign>();
  if (!record) return null;
  const locked = record.status === 'active' || record.status === 'completed';
  if (!locked) return null;
  return (
    <Alert
      severity="warning"
      sx={{ mb: 2 }}
      data-testid="campaign-locked-banner"
    >
      Kampagne ist <strong>{record.status}</strong> — Felder gesperrt.
      {record.status === 'active' && ' Erst pausieren oder stoppen.'}
    </Alert>
  );
}

function CampaignFormFields() {
  const record = useRecordContext<Campaign>();
  const locked = !record || record.status === 'active' || record.status === 'completed';

  return (
    <Box data-testid="campaign-edit-form">
      <LockedBanner />
      <TextInput
        source="name"
        label="Name"
        validate={required()}
        disabled={locked}
        fullWidth
        inputProps={{ 'data-testid': 'campaign-edit-name' }}
      />
      <SelectInput
        source="dialing_mode"
        label="Dialing Mode"
        disabled={locked}
        choices={[
          { id: 'manual',     name: 'Manual' },
          { id: 'ratio',      name: 'Ratio' },
          { id: 'predictive', name: 'Predictive' },
        ]}
        inputProps={{ 'data-testid': 'campaign-edit-mode' }}
      />
      <NumberInput
        source="dial_ratio"
        label="Dial Ratio"
        disabled={locked}
        validate={[minValue(0.1), maxValue(10)]}
        inputProps={{ 'data-testid': 'campaign-edit-ratio' }}
      />
      <TextInput
        source="timezone"
        label="Zeitzone"
        disabled={locked}
        inputProps={{ 'data-testid': 'campaign-edit-timezone' }}
      />
      <TextInput
        source="call_window_start"
        label="Start (HH:MM)"
        disabled={locked}
        inputProps={{ 'data-testid': 'campaign-edit-window-start' }}
      />
      <TextInput
        source="call_window_end"
        label="Ende (HH:MM)"
        disabled={locked}
        inputProps={{ 'data-testid': 'campaign-edit-window-end' }}
      />
      <NumberInput
        source="max_retries"
        label="Max Retries"
        disabled={locked}
        validate={[minValue(0), maxValue(10)]}
        inputProps={{ 'data-testid': 'campaign-edit-retries' }}
      />
      <NumberInput
        source="retry_interval_hours"
        label="Retry Intervall (h)"
        disabled={locked}
        validate={[minValue(1), maxValue(168)]}
        inputProps={{ 'data-testid': 'campaign-edit-retry-interval' }}
      />
      <TextInput
        source="notes"
        label="Notizen"
        multiline
        minRows={2}
        disabled={locked}
        fullWidth
        inputProps={{ 'data-testid': 'campaign-edit-notes' }}
      />
    </Box>
  );
}

export const CampaignEdit = () => (
  <Edit data-testid="campaign-edit">
    <SimpleForm>
      <CampaignFormFields />
    </SimpleForm>
  </Edit>
);
