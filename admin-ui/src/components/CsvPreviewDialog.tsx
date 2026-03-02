import { useRef, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  CircularProgress,
  Alert,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { previewCsv } from '../services/api';
import type { CsvPreviewResult } from '../types';

interface CsvPreviewDialogProps {
  open: boolean;
  campaignId: string;
  onClose: () => void;
  onPreviewReady: (file: File, preview: CsvPreviewResult) => void;
}

export function CsvPreviewDialog({
  open,
  campaignId,
  onClose,
  onPreviewReady,
}: CsvPreviewDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setError(null);
  };

  const handlePreview = async () => {
    if (!selectedFile) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await previewCsv(campaignId, selectedFile);
      onPreviewReady(selectedFile, data);
    } catch {
      setError('CSV konnte nicht gelesen werden. Bitte prüfe das Format.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      data-testid="csv-preview-dialog"
    >
      <DialogTitle>CSV importieren — Schritt 1: Datei auswählen</DialogTitle>
      <DialogContent>
        <Box
          sx={{
            border: '2px dashed',
            borderColor: 'primary.main',
            borderRadius: 2,
            p: 3,
            textAlign: 'center',
            cursor: 'pointer',
            mb: 2,
          }}
          onClick={() => fileInputRef.current?.click()}
          data-testid="csv-drop-zone"
        >
          <UploadFileIcon sx={{ fontSize: 48, color: 'primary.main', mb: 1 }} />
          <Typography>
            {selectedFile ? selectedFile.name : 'CSV Datei auswählen (max. 20 MB)'}
          </Typography>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            style={{ display: 'none' }}
            onChange={handleFileChange}
            data-testid="csv-file-input"
          />
        </Box>
        {error && (
          <Alert severity="error" data-testid="csv-preview-error">
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} data-testid="csv-preview-cancel">Abbrechen</Button>
        <Button
          variant="contained"
          disabled={!selectedFile || loading}
          onClick={() => void handlePreview()}
          data-testid="csv-preview-submit"
        >
          {loading ? <CircularProgress size={20} /> : 'Vorschau laden'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// Preview Table (shown after step 1)
interface CsvPreviewTableProps {
  preview: CsvPreviewResult;
}

export function CsvPreviewTable({ preview }: CsvPreviewTableProps) {
  return (
    <Box data-testid="csv-preview-table">
      <Typography variant="body2" color="text.secondary" gutterBottom>
        {preview.total_rows} Zeilen erkannt · Vorschau (max. 5 Zeilen)
      </Typography>
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              {preview.headers.map((h) => (
                <TableCell key={h} sx={{ fontWeight: 700 }}>
                  {h}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {preview.preview_rows.slice(0, 5).map((row, i) => (
              <TableRow key={i}>
                {row.map((cell, j) => (
                  <TableCell key={j}>{cell}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
    </Box>
  );
}
