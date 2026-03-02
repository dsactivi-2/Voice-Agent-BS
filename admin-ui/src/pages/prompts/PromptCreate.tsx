import {
  Create,
  SimpleForm,
  TextInput,
  SelectInput,
  required,
} from 'react-admin';

const PHASE_CHOICES = [
  'system','hook','qualify','pitch','objection','close','confirm',
].map((p) => ({ id: p, name: p }));

export const PromptCreate = () => (
  <Create data-testid="prompt-create">
    <SimpleForm>
      <TextInput
        source="name"
        label="Name"
        validate={required()}
        fullWidth
        inputProps={{ 'data-testid': 'prompt-name' }}
        helperText="Gleicher Name → Version auto-inkrementiert"
      />
      <SelectInput
        source="language"
        label="Sprache"
        validate={required()}
        choices={[
          { id: 'bs-BA', name: 'Bosnisch (bs-BA)' },
          { id: 'sr-RS', name: 'Serbisch (sr-RS)' },
          { id: 'any',   name: 'Any' },
        ]}
        inputProps={{ 'data-testid': 'prompt-language' }}
      />
      <SelectInput
        source="phase"
        label="Phase"
        validate={required()}
        choices={PHASE_CHOICES}
        inputProps={{ 'data-testid': 'prompt-phase' }}
      />
      <TextInput
        source="content"
        label="Inhalt"
        validate={required()}
        multiline
        minRows={6}
        fullWidth
        inputProps={{ 'data-testid': 'prompt-content' }}
      />
    </SimpleForm>
  </Create>
);
