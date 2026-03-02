import { useState } from 'react';
import {
  IconButton,
  Menu,
  MenuItem,
  ListItemText,
  Chip,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
} from '@mui/material';
import AssignmentIcon from '@mui/icons-material/Assignment';
import { useNotify } from 'react-admin';
import { setLeadDisposition } from '../../services/api';
import type { Disposition, Lead } from '../../types';

interface LeadDispositionMenuProps {
  lead: Lead;
  dispositions: Disposition[];
  onUpdated: () => void;
}

export function LeadDispositionMenu({
  lead,
  dispositions,
  onUpdated,
}: LeadDispositionMenuProps) {
  const notify = useNotify();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [noteDialog, setNoteDialog] = useState<Disposition | null>(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSelect = (disposition: Disposition) => {
    setAnchor(null);
    setNoteDialog(disposition);
    setNotes('');
  };

  const handleConfirm = async () => {
    if (!noteDialog) return;
    setSaving(true);
    try {
      // WICHTIG: disposition_code (string), NICHT dispositionId!
      const { data } = await setLeadDisposition(lead.id, noteDialog.code, notes || undefined);
      notify(
        data.status === 'dnc'
          ? 'Lead als DNC markiert (auto-DNC Registry)'
          : 'Disposition gesetzt',
        { type: 'success' }
      );
      onUpdated();
      setNoteDialog(null);
    } catch {
      notify('Fehler beim Setzen der Disposition', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <IconButton
        size="small"
        onClick={(e) => setAnchor(e.currentTarget)}
        disabled={dispositions.length === 0}
        data-testid={`lead-disp-btn-${lead.id}`}
      >
        <AssignmentIcon fontSize="small" />
      </IconButton>

      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        data-testid={`lead-disp-menu-${lead.id}`}
      >
        {dispositions.map((d) => (
          <MenuItem
            key={d.id}
            onClick={() => handleSelect(d)}
            data-testid={`lead-disp-option-${d.code}`}
          >
            <ListItemText
              primary={d.label}
              secondary={
                <>
                  {d.code}
                  {d.is_dnc && <Chip label="DNC" size="small" color="error" sx={{ ml: 1 }} />}
                  {d.is_success && <Chip label="✓" size="small" color="success" sx={{ ml: 1 }} />}
                </>
              }
            />
          </MenuItem>
        ))}
      </Menu>

      <Dialog
        open={Boolean(noteDialog)}
        onClose={() => setNoteDialog(null)}
        maxWidth="sm"
        fullWidth
        data-testid="lead-disp-confirm-dialog"
      >
        <DialogTitle>
          Disposition setzen: {noteDialog?.label} ({noteDialog?.code})
          {noteDialog?.is_dnc && (
            <Chip label="DNC" size="small" color="error" sx={{ ml: 1 }} />
          )}
        </DialogTitle>
        <DialogContent>
          <TextField
            label="Notiz (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            multiline
            minRows={2}
            fullWidth
            sx={{ mt: 1 }}
            inputProps={{ 'data-testid': 'lead-disp-notes' }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNoteDialog(null)} data-testid="lead-disp-cancel">
            Abbrechen
          </Button>
          <Button
            variant="contained"
            disabled={saving}
            onClick={() => void handleConfirm()}
            data-testid="lead-disp-confirm"
          >
            {saving ? <CircularProgress size={20} /> : 'Bestätigen'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
