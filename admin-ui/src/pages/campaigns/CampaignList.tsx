import {
  List,
  Datagrid,
  TextField,
  SelectInput,
  FilterButton,
  TopToolbar,
  CreateButton,
  EditButton,
  DeleteButton,
  useRecordContext,
} from 'react-admin';
import { Box } from '@mui/material';
import { StatusChip } from '../../components/StatusChip';
import { StatusTransitionButtons } from '../../components/StatusTransitionButtons';
import type { Campaign, CampaignStatus } from '../../types';

const CampaignFilters = [
  <SelectInput
    key="status"
    source="status"
    label="Status"
    choices={[
      { id: 'draft',     name: 'Entwurf' },
      { id: 'active',    name: 'Aktiv' },
      { id: 'paused',    name: 'Pausiert' },
      { id: 'stopped',   name: 'Gestoppt' },
      { id: 'completed', name: 'Abgeschlossen' },
    ]}
    alwaysOn
  />,
];

function CampaignStatusField() {
  const record = useRecordContext<Campaign>();
  if (!record) return null;
  return <StatusChip status={record.status} />;
}

function CampaignTransitions() {
  const record = useRecordContext<Campaign>();
  if (!record) return null;
  return (
    <StatusTransitionButtons
      campaignId={record.id}
      currentStatus={record.status as CampaignStatus}
    />
  );
}

function CampaignDeleteButton() {
  const record = useRecordContext<Campaign>();
  if (!record) return null;
  const locked = record.status === 'active' || record.status === 'paused';
  return (
    <DeleteButton
      disabled={locked}
      confirmTitle="Kampagne löschen?"
      confirmContent={
        locked
          ? 'Kampagne zuerst stoppen!'
          : 'Kampagne wird permanent gelöscht.'
      }
      data-testid="campaign-delete-btn"
    />
  );
}

const CampaignListActions = () => (
  <TopToolbar>
    <FilterButton />
    <CreateButton data-testid="campaign-create-btn" />
  </TopToolbar>
);

export const CampaignList = () => (
  <List
    filters={CampaignFilters}
    actions={<CampaignListActions />}
    sort={{ field: 'name', order: 'ASC' }}
    data-testid="campaign-list"
  >
    <Datagrid rowClick={false} bulkActionButtons={false}>
      <TextField source="name" label="Name" />
      <CampaignStatusField />
      <TextField source="dialing_mode" label="Modus" />
      <Box component="td">
        <CampaignTransitions />
      </Box>
      <EditButton data-testid="campaign-edit-btn" />
      <CampaignDeleteButton />
    </Datagrid>
  </List>
);
