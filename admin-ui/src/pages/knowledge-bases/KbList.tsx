import {
  List,
  Datagrid,
  TextField,
  TopToolbar,
  CreateButton,
  EditButton,
  DeleteButton,
  useRecordContext,
} from 'react-admin';
import { Button } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { useNavigate } from 'react-router-dom';
import type { KnowledgeBase } from '../../types';

function KbDocumentsButton() {
  const record = useRecordContext<KnowledgeBase>();
  const navigate = useNavigate();
  if (!record) return null;
  return (
    <Button
      size="small"
      startIcon={<FolderOpenIcon />}
      onClick={() => navigate(`/knowledge-bases/${record.id}/documents`)}
      data-testid={`kb-docs-btn-${record.id}`}
    >
      Dokumente
    </Button>
  );
}

const KbListActions = () => (
  <TopToolbar>
    <CreateButton data-testid="kb-create-btn" />
  </TopToolbar>
);

export const KbList = () => (
  <List
    actions={<KbListActions />}
    sort={{ field: 'name', order: 'ASC' }}
    data-testid="kb-list"
  >
    {/* WICHTIG: response key = knowledge_bases (snake_case) — dataProvider handhabt das */}
    <Datagrid rowClick={false} bulkActionButtons={false}>
      <TextField source="name" label="Name" />
      <TextField source="description" label="Beschreibung" />
      <TextField source="chunks_to_retrieve" label="Chunks" />
      <TextField source="similarity_threshold" label="Threshold" />
      <KbDocumentsButton />
      <EditButton data-testid="kb-edit-btn" />
      <DeleteButton
        confirmTitle="Knowledge Base löschen?"
        confirmContent="Alle Dokumente werden ebenfalls gelöscht."
        data-testid="kb-delete-btn"
      />
    </Datagrid>
  </List>
);
