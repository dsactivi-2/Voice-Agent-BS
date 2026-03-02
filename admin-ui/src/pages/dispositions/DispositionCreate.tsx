import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Button,
  TextField,
  FormControlLabel,
  Switch,
  Stack,
  CircularProgress,
  Alert,
  IconButton,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useNotify } from 'react-admin';
import { axiosClient } from '../../providers/axiosClient';

const CODE_REGEX = /^[A-Z0-9_]+$/;

export function DispositionCreate() {
  const { id: campaignId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const notify = useNotify();

  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [isSuccess, setIsSuccess] = useState(false);
  const [isDnc, setIsDnc] = useState(false);
  const [retryAllowed, setRetryAllowed] = useState(true);
  const [retryAfterHours, setRetryAfterHours] = useState(24);
  const [sortOrder, setSortOrder] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const codeValid = CODE_REGEX.test(code);

  const handleSave = async () => {
    if (!campaignId) return;
    if (!code || !label) { setError('Code und Label sind Pflichtfelder'); return; }
    if (!codeValid) { setError('Code: nur GROSSBUCHSTABEN, Ziffern, Unterstrich erlaubt'); return; }

    setSaving(true);
    setError(null);
    try {
      await axiosClient.post(`/campaigns/${campaignId}/dispositions`, {
        code,
        label,
        is_success: isSuccess,
        is_dnc: isDnc,
        retry_allowed: retryAllowed,
        retry_after_hours: retryAfterHours,
        sort_order: sortOrder,
      });
      notify('Disposition erstellt', { type: 'success' });
      navigate(`/campaigns/${campaignId}/dispositions`);
    } catch {
      setError('Fehler beim Erstellen');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box p={3} maxWidth={600} data-testid="disposition-create">
      <Box display="flex" alignItems="center" gap={1} mb={3}>
        <IconButton onClick={() => navigate(-1)} data-testid="disp-create-back">
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h5">Neue Disposition</Typography>
      </Box>

      <Stack spacing={2}>
        <TextField
          label="Code (UPPERCASE/DIGITS/_ only)"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          error={code.length > 0 && !codeValid}
          helperText={
            code.length > 0 && !codeValid
              ? 'Nur GROSSBUCHSTABEN, Ziffern und _ erlaubt'
              : 'z.B. INTERESTED, NOT_AVAILABLE'
          }
          required
          fullWidth
          inputProps={{ 'data-testid': 'disp-create-code' }}
        />
        <TextField
          label="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
          fullWidth
          inputProps={{ 'data-testid': 'disp-create-label' }}
        />
        <TextField
          label="Retry nach Stunden (0–720)"
          type="number"
          value={retryAfterHours}
          onChange={(e) => setRetryAfterHours(Number(e.target.value))}
          inputProps={{ min: 0, max: 720, 'data-testid': 'disp-create-retry-hours' }}
          fullWidth
        />
        <TextField
          label="Sort-Reihenfolge"
          type="number"
          value={sortOrder}
          onChange={(e) => setSortOrder(Number(e.target.value))}
          inputProps={{ 'data-testid': 'disp-create-sort' }}
          fullWidth
        />
        <FormControlLabel
          control={
            <Switch
              checked={isSuccess}
              onChange={(e) => setIsSuccess(e.target.checked)}
              data-testid="disp-create-is-success"
            />
          }
          label="Erfolg (is_success)"
        />
        <FormControlLabel
          control={
            <Switch
              checked={isDnc}
              onChange={(e) => setIsDnc(e.target.checked)}
              data-testid="disp-create-is-dnc"
            />
          }
          label="DNC — Lead wird automatisch gesperrt"
        />
        <FormControlLabel
          control={
            <Switch
              checked={retryAllowed}
              onChange={(e) => setRetryAllowed(e.target.checked)}
              data-testid="disp-create-retry-allowed"
            />
          }
          label="Retry erlaubt"
        />

        {error && <Alert severity="error" data-testid="disp-create-error">{error}</Alert>}

        <Button
          variant="contained"
          onClick={() => void handleSave()}
          disabled={saving || !code || !label || !codeValid}
          data-testid="disp-create-save"
        >
          {saving ? <CircularProgress size={20} /> : 'Erstellen'}
        </Button>
      </Stack>
    </Box>
  );
}
