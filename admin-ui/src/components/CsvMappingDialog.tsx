import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  Stack,
  Typography,
  TextField,
  CircularProgress,
  Alert,
} from '@mui/material';
import { importCsv } from '../services/api';
import type { CsvPreviewResult, ImportResult } from '../types';

interface CsvMappingDialogProps {
  open: boolean;
  campaignId: string;
  file: File;
  preview: CsvPreviewResult;
  onClose: () => void;
  onImported: (result: ImportResult) => void;
}

export function CsvMappingDialog({
  open,
  campaignId,
  file,
  preview,
  onClose,
  onImported,
}: CsvMappingDialogProps) {
  // mappable_fields from server = valid DB target fields
  const dbFields = preview.mappable_fields;
  const csvHeaders = preview.headers;

  // mapping: dbField → csvHeader
  const [mapping, setMapping] = useState<Record<string, string>>(() => {
    // Auto-map: find matching headers
    const auto: Record<string, string> = {};
    dbFields.forEach((field) => {
      const match = csvHeaders.find(
        (h) => h.toLowerCase().replace(/\s+/g, '_') === field.toLowerCase()
      );
      if (match) auto[field] = match;
    });
    return auto;
  });

  const [listName, setListName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phoneMapped = !!mapping['phone_primary'];

  const handleImport = async () => {
    if (!phoneMapped) {
      setError('phone_primary muss gemappt werden!');
      return;
    }
    // Only send fields that are actually mapped
    const activeMappings = Object.fromEntries(
      Object.entries(mapping).filter(([, v]) => v !== '')
    );
    setLoading(true);
    setError(null);
    try {
      const { data } = await importCsv(campaignId, file, activeMappings, listName || undefined);
      onImported(data);
    } catch {
      setError('Import fehlgeschlagen. Bitte prüfe die Spalten-Zuordnung.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      data-testid="csv-mapping-dialog"
    >
      <DialogTitle>CSV importieren — Schritt 2: Spalten zuordnen</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Listen-Name (optional)"
            value={listName}
            onChange={(e) => setListName(e.target.value)}
            fullWidth
            inputProps={{ 'data-testid': 'csv-list-name' }}
          />

          {!phoneMapped && (
            <Alert severity="warning" data-testid="csv-phone-warning">
              phone_primary muss zugeordnet werden (Pflicht)
            </Alert>
          )}

          {dbFields.map((field) => (
            <FormControl key={field} fullWidth>
              <InputLabel id={`label-${field}`}>
                {field}
                {field === 'phone_primary' ? ' *' : ''}
              </InputLabel>
              <Select
                labelId={`label-${field}`}
                value={mapping[field] ?? ''}
                label={field + (field === 'phone_primary' ? ' *' : '')}
                onChange={(e) =>
                  setMapping((prev) => ({ ...prev, [field]: e.target.value }))
                }
                inputProps={{ 'data-testid': `csv-map-${field}` }}
              >
                <MenuItem value="">
                  <em>— nicht verwenden —</em>
                </MenuItem>
                {csvHeaders.map((h) => (
                  <MenuItem key={h} value={h}>
                    {h}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ))}

          {error && (
            <Alert severity="error" data-testid="csv-mapping-error">
              {error}
            </Alert>
          )}

          <Typography variant="caption" color="text.secondary">
            Datei: {file.name} · {preview.total_rows} Zeilen
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} data-testid="csv-mapping-cancel">Abbrechen</Button>
        <Button
          variant="contained"
          disabled={!phoneMapped || loading}
          onClick={() => void handleImport()}
          data-testid="csv-mapping-import"
        >
          {loading ? <CircularProgress size={20} /> : 'Importieren'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
