import {
  Create,
  SimpleForm,
  TextInput,
  SelectInput,
  NumberInput,
  required,
  minValue,
  maxValue,
} from 'react-admin';

export const CampaignCreate = () => (
  <Create data-testid="campaign-create">
    <SimpleForm>
      <TextInput
        source="name"
        label="Name"
        validate={required()}
        fullWidth
        inputProps={{ 'data-testid': 'campaign-name' }}
      />
      <SelectInput
        source="dialing_mode"
        label="Dialing Mode"
        defaultValue="ratio"
        choices={[
          { id: 'manual',     name: 'Manual' },
          { id: 'ratio',      name: 'Ratio (Standard)' },
          { id: 'predictive', name: 'Predictive' },
        ]}
        inputProps={{ 'data-testid': 'campaign-dialing-mode' }}
      />
      <NumberInput
        source="dial_ratio"
        label="Dial Ratio (0.1–10)"
        defaultValue={1.0}
        validate={[minValue(0.1), maxValue(10)]}
        inputProps={{ 'data-testid': 'campaign-dial-ratio' }}
      />
      <TextInput
        source="timezone"
        label="Zeitzone"
        defaultValue="Europe/Sarajevo"
        inputProps={{ 'data-testid': 'campaign-timezone' }}
      />
      <TextInput
        source="call_window_start"
        label="Anruf-Start (HH:MM)"
        defaultValue="09:00"
        inputProps={{ 'data-testid': 'campaign-window-start' }}
      />
      <TextInput
        source="call_window_end"
        label="Anruf-Ende (HH:MM)"
        defaultValue="18:00"
        inputProps={{ 'data-testid': 'campaign-window-end' }}
      />
      <NumberInput
        source="max_retries"
        label="Max. Retries (0–10)"
        defaultValue={3}
        validate={[minValue(0), maxValue(10)]}
        inputProps={{ 'data-testid': 'campaign-max-retries' }}
      />
      <NumberInput
        source="retry_interval_hours"
        label="Retry Intervall (Stunden)"
        defaultValue={24}
        validate={[minValue(1), maxValue(168)]}
        inputProps={{ 'data-testid': 'campaign-retry-interval' }}
      />
      <TextInput
        source="notes"
        label="Notizen"
        multiline
        minRows={2}
        fullWidth
        inputProps={{ 'data-testid': 'campaign-notes' }}
      />
    </SimpleForm>
  </Create>
);
