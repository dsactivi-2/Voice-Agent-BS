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

const TTS_VOICES = [
  { id: 'bs-BA-GoranNeural',   name: 'Goran (bs-BA)' },
  { id: 'bs-BA-VesnaNeural',   name: 'Vesna (bs-BA)' },
  { id: 'sr-RS-SophieNeural',  name: 'Sophie (sr-RS)' },
  { id: 'sr-RS-NicholasNeural',name: 'Nicholas (sr-RS)' },
];

export const AgentCreate = () => (
  <Create data-testid="agent-create">
    <SimpleForm>
      {/* REQUIRED FIELDS */}
      <TextInput
        source="name"
        label="Name"
        validate={required()}
        fullWidth
        inputProps={{ 'data-testid': 'agent-name' }}
      />
      <SelectInput
        source="language"
        label="Sprache"
        validate={required()}
        choices={[
          { id: 'bs-BA', name: 'Bosnisch (bs-BA)' },
          { id: 'sr-RS', name: 'Serbisch (sr-RS)' },
        ]}
        inputProps={{ 'data-testid': 'agent-language' }}
      />
      <SelectInput
        source="tts_voice"
        label="TTS Voice (REQUIRED)"
        validate={required()}
        choices={TTS_VOICES}
        inputProps={{ 'data-testid': 'agent-tts-voice' }}
      />

      {/* OPTIONAL FIELDS */}
      <SelectInput
        source="llm_model"
        label="LLM Model"
        defaultValue="gpt-4o-mini"
        choices={[
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Standard)' },
          { id: 'gpt-4o',      name: 'GPT-4o (Full)' },
        ]}
        inputProps={{ 'data-testid': 'agent-llm-model' }}
      />
      <NumberInput
        source="temperature"
        label="Temperature (0-2)"
        defaultValue={0.7}
        validate={[minValue(0), maxValue(2)]}
        inputProps={{ 'data-testid': 'agent-temperature' }}
      />
    </SimpleForm>
  </Create>
);
