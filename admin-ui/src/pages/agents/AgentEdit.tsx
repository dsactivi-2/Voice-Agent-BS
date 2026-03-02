import {
  Edit,
  SimpleForm,
  TextInput,
  SelectInput,
  NumberInput,
  required,
  minValue,
  maxValue,
} from 'react-admin';

const TTS_VOICES = [
  { id: 'bs-BA-GoranNeural',    name: 'Goran (bs-BA)' },
  { id: 'bs-BA-VesnaNeural',    name: 'Vesna (bs-BA)' },
  { id: 'sr-RS-SophieNeural',   name: 'Sophie (sr-RS)' },
  { id: 'sr-RS-NicholasNeural', name: 'Nicholas (sr-RS)' },
];

const PHASES = ['system', 'hook', 'qualify', 'pitch', 'objection', 'close', 'confirm'];

export const AgentEdit = () => (
  <Edit data-testid="agent-edit">
    <SimpleForm>
      <TextInput
        source="name"
        label="Name"
        validate={required()}
        fullWidth
        inputProps={{ 'data-testid': 'agent-edit-name' }}
      />
      <SelectInput
        source="language"
        label="Sprache"
        validate={required()}
        choices={[
          { id: 'bs-BA', name: 'Bosnisch (bs-BA)' },
          { id: 'sr-RS', name: 'Serbisch (sr-RS)' },
        ]}
        inputProps={{ 'data-testid': 'agent-edit-language' }}
      />
      <SelectInput
        source="tts_voice"
        label="TTS Voice"
        validate={required()}
        choices={TTS_VOICES}
        inputProps={{ 'data-testid': 'agent-edit-tts-voice' }}
      />
      <SelectInput
        source="llm_model"
        label="LLM Model"
        choices={[
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
          { id: 'gpt-4o',      name: 'GPT-4o (Full)' },
        ]}
        inputProps={{ 'data-testid': 'agent-edit-llm-model' }}
      />
      <NumberInput
        source="temperature"
        label="Temperature (0-2)"
        validate={[minValue(0), maxValue(2)]}
        inputProps={{ 'data-testid': 'agent-edit-temperature' }}
      />

      {/* Prompt-Felder für alle 7 Phasen */}
      {PHASES.map((phase) => (
        <TextInput
          key={phase}
          source={`prompts.${phase}`}
          label={`Prompt: ${phase}`}
          multiline
          minRows={3}
          fullWidth
          inputProps={{ 'data-testid': `agent-prompt-${phase}` }}
        />
      ))}

      {/* Memory Config */}
      <NumberInput
        source="memory_config.window_turns"
        label="Memory: Window Turns"
        inputProps={{ 'data-testid': 'agent-memory-window' }}
      />
      <NumberInput
        source="memory_config.summary_interval"
        label="Memory: Summary Interval"
        inputProps={{ 'data-testid': 'agent-memory-interval' }}
      />
    </SimpleForm>
  </Edit>
);
