import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  FormControlLabel,
  Switch,
  Stack,
  CircularProgress,
} from '@mui/material';
import { useNotify, useRefresh } from 'react-admin';
import { axiosClient } from '../providers/axiosClient';
import type { Disposition } from '../types';

interface DispositionEditModalProps {
  open: boolean;
  onClose: () => void;
  campaignId: string;
  disposition: Disposition;
}

export function DispositionEditModal({
  open,
  onClose,
  campaignId,
  disposition,
}: DispositionEditModalProps) {
  const notify = useNotify();
  const refresh = useRefresh();

  const [label, setLabel] = useState(disposition.label);
  const [isSuccess, setIsSuccess] = useState(disposition.is_success);
  const [isDnc, setIsDnc] = useState(disposition.is_dnc);
  const [retryAllowed, setRetryAllowed] = useState(disposition.retry_allowed);
  const [retryAfterHours, setRetryAfterHours] = useState(disposition.retry_after_hours);
  const [sortOrder, setSortOrder] = useState(disposition.sort_order);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!label.trim()) {
      notify('Label ist pflichtfeld', { type: 'error' });
      return;
    }
    setSaving(true);
    try {
      await axiosClient.put(
        `/campaigns/${campaignId}/dispositions/${disposition.id}`,
        {
          label: label.trim(),
          is_success: isSuccess,
          is_dnc: isDnc,
          retry_allowed: retryAllowed,
          retry_after_hours: retryAfterHours,
          sort_order: sortOrder,
        }
      );
      notify('Disposition aktualisiert', { type: 'success' });
      refresh();
      onClose();
    } catch {
      notify('Fehler beim Speichern', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      data-testid="disposition-edit-modal"
    >
      <DialogTitle>Disposition bearbeiten — {disposition.code}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
            fullWidth
            inputProps={{ 'data-testid': 'disp-edit-label' }}
          />
          <TextField
            label="Retry nach Stunden"
            type="number"
            value={retryAfterHours}
            onChange={(e) => setRetryAfterHours(Number(e.target.value))}
            inputProps={{ min: 0, max: 720, 'data-testid': 'disp-edit-retry-hours' }}
            fullWidth
          />
          <TextField
            label="Sort-Reihenfolge"
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(Number(e.target.value))}
            inputProps={{ 'data-testid': 'disp-edit-sort-order' }}
            fullWidth
          />
          <FormControlLabel
            control={
              <Switch
                checked={isSuccess}
                onChange={(e) => setIsSuccess(e.target.checked)}
                data-testid="disp-edit-is-success"
              />
            }
            label="Erfolg (is_success)"
          />
          <FormControlLabel
            control={
              <Switch
                checked={isDnc}
                onChange={(e) => setIsDnc(e.target.checked)}
                data-testid="disp-edit-is-dnc"
              />
            }
            label="DNC (is_dnc) — Lead wird automatisch auf DNC-Liste gesetzt"
          />
          <FormControlLabel
            control={
              <Switch
                checked={retryAllowed}
                onChange={(e) => setRetryAllowed(e.target.checked)}
                data-testid="disp-edit-retry-allowed"
              />
            }
            label="Retry erlaubt"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} data-testid="disp-edit-cancel">Abbrechen</Button>
        <Button
          variant="contained"
          onClick={() => void handleSave()}
          disabled={saving}
          data-testid="disp-edit-save"
        >
          {saving ? <CircularProgress size={20} /> : 'Speichern'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
