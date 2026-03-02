import {
  List,
  Datagrid,
  TextField,
  SelectInput,
  FilterButton,
  TopToolbar,
  CreateButton,
  EditButton,
  useRecordContext,
  useNotify,
  useRefresh,
} from 'react-admin';
import { Switch, CircularProgress } from '@mui/material';
import { useState } from 'react';
import { setPromptActive } from '../../services/api';
import type { Prompt } from '../../types';

const PromptFilters = [
  <SelectInput
    key="language"
    source="language"
    label="Sprache"
    choices={[
      { id: 'bs-BA', name: 'Bosnisch' },
      { id: 'sr-RS', name: 'Serbisch' },
      { id: 'any',   name: 'Any' },
    ]}
    alwaysOn
  />,
  <SelectInput
    key="phase"
    source="phase"
    label="Phase"
    choices={[
      'system','hook','qualify','pitch','objection','close','confirm',
    ].map((p) => ({ id: p, name: p }))}
    alwaysOn
  />,
];

// Active toggle: reads current value → inverts → sends explicit bool
function PromptActiveToggle() {
  const record = useRecordContext<Prompt>();
  const notify = useNotify();
  const refresh = useRefresh();
  const [loading, setLoading] = useState(false);

  if (!record) return null;

  const handleToggle = async () => {
    setLoading(true);
    try {
      await setPromptActive(record.id, !record.is_active);
      notify(
        `Prompt ${record.is_active ? 'deaktiviert' : 'aktiviert'}`,
        { type: 'success' }
      );
      refresh();
    } catch {
      notify('Fehler beim Umschalten', { type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return loading ? (
    <CircularProgress size={20} />
  ) : (
    <Switch
      checked={record.is_active}
      size="small"
      onChange={() => void handleToggle()}
      data-testid={`prompt-active-toggle-${record.id}`}
    />
  );
}

const PromptListActions = () => (
  <TopToolbar>
    <FilterButton />
    <CreateButton data-testid="prompt-create-btn" />
  </TopToolbar>
);

export const PromptList = () => (
  <List
    filters={PromptFilters}
    actions={<PromptListActions />}
    sort={{ field: 'name', order: 'ASC' }}
    data-testid="prompt-list"
  >
    <Datagrid rowClick="edit" bulkActionButtons={false}>
      <TextField source="name" label="Name" />
      <TextField source="language" label="Sprache" />
      <TextField source="phase" label="Phase" />
      <TextField source="version" label="v" />
      <PromptActiveToggle />
      <EditButton data-testid="prompt-edit-btn" />
    </Datagrid>
  </List>
);
