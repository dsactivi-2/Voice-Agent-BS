import { useEffect, useState } from 'react';
import {
  Edit,
  SimpleForm,
  TextInput,
  SelectInput,
  required,
  useRecordContext,
} from 'react-admin';
import { Box, Typography, Chip, Stack, Divider } from '@mui/material';
import { getPromptVersions } from '../../services/api';
import type { Prompt } from '../../types';

const PHASE_CHOICES = [
  'system','hook','qualify','pitch','objection','close','confirm',
].map((p) => ({ id: p, name: p }));

function VersionHistory() {
  const record = useRecordContext<Prompt>();
  const [versions, setVersions] = useState<Prompt[]>([]);

  useEffect(() => {
    if (!record?.name) return;
    getPromptVersions(record.name)
      .then(({ data }) => setVersions(data.versions as Prompt[]))
      .catch(() => {/* non-critical */});
  }, [record?.name]); // record object excluded — only name change triggers reload

  if (versions.length === 0) return null;

  return (
    <Box data-testid="prompt-version-history">
      <Divider sx={{ my: 2 }} />
      <Typography variant="subtitle2" gutterBottom>
        Versionsverlauf — {record?.name}
      </Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap">
        {versions.map((v) => (
          <Chip
            key={v.id}
            label={`v${v.version}${v.is_active ? ' ✓' : ''}`}
            size="small"
            color={v.is_active ? 'success' : 'default'}
            data-testid={`prompt-version-chip-${v.version}`}
          />
        ))}
      </Stack>
    </Box>
  );
}

export const PromptEdit = () => (
  <Edit data-testid="prompt-edit">
    <SimpleForm>
      <TextInput
        source="name"
        label="Name"
        validate={required()}
        fullWidth
        inputProps={{ 'data-testid': 'prompt-edit-name' }}
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
        inputProps={{ 'data-testid': 'prompt-edit-language' }}
      />
      <SelectInput
        source="phase"
        label="Phase"
        validate={required()}
        choices={PHASE_CHOICES}
        inputProps={{ 'data-testid': 'prompt-edit-phase' }}
      />
      <TextInput
        source="content"
        label="Inhalt"
        validate={required()}
        multiline
        minRows={8}
        fullWidth
        inputProps={{ 'data-testid': 'prompt-edit-content' }}
      />
      <VersionHistory />
    </SimpleForm>
  </Edit>
);
