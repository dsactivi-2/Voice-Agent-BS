import { useState } from 'react';
import {
  List,
  Datagrid,
  TextField,
  SearchInput,
  TopToolbar,
  FilterButton,
  useNotify,
  useRefresh,
  DeleteButton,
} from 'react-admin';
import {
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField as MuiTextField,
  Box,
  Alert,
  Typography,
  CircularProgress,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import { axiosClient } from '../../providers/axiosClient';
import { checkDnc } from '../../services/api';
import type { DncCheckResult } from '../../types';

const DncFilters = [
  <SearchInput key="search" source="search" alwaysOn data-testid="dnc-search" />,
];

// Add DNC entry dialog
function AddDncDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const notify = useNotify();
  const refresh = useRefresh();
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!phone.trim()) return;
    setSaving(true);
    try {
      // WICHTIG: field heisst 'phone' NICHT 'phoneNumber'!
      await axiosClient.post('/dnc', {
        phone: phone.trim(),
        reason: reason.trim() || undefined,
        source: 'manual',
      });
      notify('Nummer zur DNC-Liste hinzugefügt', { type: 'success' });
      refresh();
      setPhone('');
      setReason('');
      onClose();
    } catch {
      notify('Fehler beim Hinzufügen', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-testid="dnc-add-dialog">
      <DialogTitle>Nummer zur DNC-Liste hinzufügen</DialogTitle>
      <DialogContent>
        <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <MuiTextField
            label="Telefonnummer (z.B. +38761...)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
            fullWidth
            inputProps={{ 'data-testid': 'dnc-add-phone' }}
          />
          <MuiTextField
            label="Grund (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            fullWidth
            inputProps={{ 'data-testid': 'dnc-add-reason' }}
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} data-testid="dnc-add-cancel">Abbrechen</Button>
        <Button
          variant="contained"
          disabled={!phone.trim() || saving}
          onClick={() => void handleSave()}
          data-testid="dnc-add-save"
        >
          {saving ? <CircularProgress size={20} /> : 'Hinzufügen'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// Check DNC dialog
function CheckDncDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DncCheckResult | null>(null);

  const handleCheck = async () => {
    if (!phone.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const { data } = await checkDnc(phone.trim());
      setResult(data);
    } catch {
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-testid="dnc-check-dialog">
      <DialogTitle>Nummer prüfen</DialogTitle>
      <DialogContent>
        <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <MuiTextField
            label="Telefonnummer"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            fullWidth
            inputProps={{ 'data-testid': 'dnc-check-phone' }}
          />
          {result && (
            <Alert
              severity={result.is_dnc ? 'error' : 'success'}
              data-testid="dnc-check-result"
            >
              <Typography>
                {result.phone} ist{' '}
                <strong>{result.is_dnc ? 'auf der DNC-Liste' : 'NICHT auf der DNC-Liste'}</strong>
              </Typography>
              {result.reason && (
                <Typography variant="caption">Grund: {result.reason}</Typography>
              )}
            </Alert>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} data-testid="dnc-check-close">Schließen</Button>
        <Button
          variant="contained"
          disabled={!phone.trim() || loading}
          onClick={() => void handleCheck()}
          data-testid="dnc-check-submit"
        >
          {loading ? <CircularProgress size={20} /> : 'Prüfen'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function DncListActions() {
  const [addOpen, setAddOpen] = useState(false);
  const [checkOpen, setCheckOpen] = useState(false);
  return (
    <TopToolbar>
      <FilterButton />
      <Button
        startIcon={<SearchIcon />}
        onClick={() => setCheckOpen(true)}
        data-testid="dnc-check-btn"
        size="small"
      >
        Prüfen
      </Button>
      <Button
        variant="contained"
        startIcon={<AddIcon />}
        onClick={() => setAddOpen(true)}
        data-testid="dnc-add-btn"
        size="small"
      >
        Hinzufügen
      </Button>
      <AddDncDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <CheckDncDialog open={checkOpen} onClose={() => setCheckOpen(false)} />
    </TopToolbar>
  );
}

export const DncList = () => (
  <List
    filters={DncFilters}
    actions={<DncListActions />}
    sort={{ field: 'created_at', order: 'DESC' }}
    data-testid="dnc-list"
  >
    <Datagrid bulkActionButtons={false}>
      {/* WICHTIG: response field heisst 'phone' NICHT 'phoneNumber' */}
      <TextField source="phone" label="Telefon" />
      <TextField source="reason" label="Grund" />
      <TextField source="source" label="Quelle" />
      <TextField source="created_at" label="Erstellt" />
      <DeleteButton
        confirmTitle="Eintrag löschen?"
        confirmContent="Nummer wird von der DNC-Liste entfernt."
        data-testid="dnc-delete-btn"
      />
    </Datagrid>
  </List>
);
