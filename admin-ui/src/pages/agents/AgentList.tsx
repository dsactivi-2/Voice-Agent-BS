import {
  List,
  Datagrid,
  TextField,
  BooleanField,
  SelectInput,
  FilterButton,
  TopToolbar,
  CreateButton,
  EditButton,
  DeleteButton,
  useRecordContext,
  useNotify,
  useRefresh,
} from 'react-admin';
import { Chip } from '@mui/material';

// Filter toolbar
const AgentFilters = [
  <SelectInput
    key="language"
    source="language"
    label="Sprache"
    choices={[
      { id: 'bs-BA', name: 'Bosnisch (bs-BA)' },
      { id: 'sr-RS', name: 'Serbisch (sr-RS)' },
    ]}
    alwaysOn
  />,
  <SelectInput
    key="active"
    source="active"
    label="Status"
    choices={[
      { id: 'true', name: 'Aktiv' },
      { id: 'false', name: 'Inaktiv' },
    ]}
    alwaysOn
  />,
];

const AgentListActions = () => (
  <TopToolbar>
    <FilterButton />
    <CreateButton data-testid="agent-create-btn" />
  </TopToolbar>
);

// is_active chip
function ActiveChip() {
  const record = useRecordContext<{ is_active: boolean }>();
  if (!record) return null;
  return (
    <Chip
      size="small"
      label={record.is_active ? 'AKTIV' : 'INAKTIV'}
      color={record.is_active ? 'success' : 'default'}
      data-testid={`agent-active-${record.is_active}`}
    />
  );
}

// Soft-delete warning
function AgentDeleteButton() {
  const notify = useNotify();
  const refresh = useRefresh();
  return (
    <DeleteButton
      confirmTitle="Agent deaktivieren?"
      confirmContent="Der Agent wird deaktiviert (Soft Delete — Daten bleiben erhalten)."
      mutationOptions={{
        onSuccess: () => {
          notify('Agent deaktiviert (Soft Delete)', { type: 'info' });
          refresh();
        },
      }}
      data-testid="agent-delete-btn"
    />
  );
}

export const AgentList = () => (
  <List
    filters={AgentFilters}
    actions={<AgentListActions />}
    sort={{ field: 'name', order: 'ASC' }}
    data-testid="agent-list"
  >
    <Datagrid rowClick="edit" bulkActionButtons={false}>
      <TextField source="name" label="Name" />
      <TextField source="language" label="Sprache" />
      <TextField source="tts_voice" label="TTS Voice" />
      <TextField source="llm_model" label="LLM" />
      <BooleanField source="is_active" label="Aktiv" />
      <ActiveChip />
      <EditButton data-testid="agent-edit-btn" />
      <AgentDeleteButton />
    </Datagrid>
  </List>
);
