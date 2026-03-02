import { Create, SimpleForm, TextInput, NumberInput, required, minValue, maxValue } from 'react-admin';

export const KbCreate = () => (
  <Create data-testid="kb-create">
    <SimpleForm>
      <TextInput
        source="name"
        label="Name"
        validate={required()}
        fullWidth
        inputProps={{ 'data-testid': 'kb-name' }}
      />
      <TextInput
        source="description"
        label="Beschreibung"
        multiline
        minRows={2}
        fullWidth
        inputProps={{ 'data-testid': 'kb-description' }}
      />
      <NumberInput
        source="chunks_to_retrieve"
        label="Chunks (1–10)"
        defaultValue={3}
        validate={[minValue(1), maxValue(10)]}
        inputProps={{ 'data-testid': 'kb-chunks' }}
      />
      <NumberInput
        source="similarity_threshold"
        label="Ähnlichkeits-Schwelle (0–1)"
        defaultValue={0.6}
        validate={[minValue(0), maxValue(1)]}
        inputProps={{ 'data-testid': 'kb-threshold' }}
      />
    </SimpleForm>
  </Create>
);
