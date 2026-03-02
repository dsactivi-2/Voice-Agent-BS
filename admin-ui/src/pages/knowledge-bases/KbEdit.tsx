import { Edit, SimpleForm, TextInput, NumberInput, required, minValue, maxValue } from 'react-admin';

export const KbEdit = () => (
  <Edit data-testid="kb-edit">
    <SimpleForm>
      <TextInput
        source="name"
        label="Name"
        validate={required()}
        fullWidth
        inputProps={{ 'data-testid': 'kb-edit-name' }}
      />
      <TextInput
        source="description"
        label="Beschreibung"
        multiline
        minRows={2}
        fullWidth
        inputProps={{ 'data-testid': 'kb-edit-description' }}
      />
      <NumberInput
        source="chunks_to_retrieve"
        label="Chunks (1–10)"
        validate={[minValue(1), maxValue(10)]}
        inputProps={{ 'data-testid': 'kb-edit-chunks' }}
      />
      <NumberInput
        source="similarity_threshold"
        label="Ähnlichkeits-Schwelle (0–1)"
        validate={[minValue(0), maxValue(1)]}
        inputProps={{ 'data-testid': 'kb-edit-threshold' }}
      />
    </SimpleForm>
  </Edit>
);
