import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box, Typography, Stepper, Step, StepLabel, Paper,
  Button, Alert, Divider, IconButton,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { CsvPreviewDialog, CsvPreviewTable } from '../../components/CsvPreviewDialog';
import { CsvMappingDialog } from '../../components/CsvMappingDialog';
import type { CsvPreviewResult, ImportResult } from '../../types';

const STEPS = ['Datei auswählen', 'Spalten zuordnen', 'Fertig'];

export function CsvImportPage() {
  const { id: campaignId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [activeStep, setActiveStep] = useState(0);
  const [previewDialogOpen, setPreviewDialogOpen] = useState(true);
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvPreviewResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const handlePreviewReady = (f: File, p: CsvPreviewResult) => {
    setFile(f);
    setPreview(p);
    setPreviewDialogOpen(false);
    setMappingDialogOpen(true);
    setActiveStep(1);
  };

  const handleImported = (result: ImportResult) => {
    setImportResult(result);
    setMappingDialogOpen(false);
    setActiveStep(2);
  };

  if (!campaignId) return null;

  return (
    <Box p={3} data-testid="csv-import-page">
      <Box display="flex" alignItems="center" gap={2} mb={3}>
        <IconButton onClick={() => navigate(-1)} data-testid="import-back">
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h5">CSV Leads importieren</Typography>
      </Box>

      <Stepper activeStep={activeStep} sx={{ mb: 3 }} data-testid="import-stepper">
        {STEPS.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      {/* Step 0: Preview dialog */}
      <CsvPreviewDialog
        open={previewDialogOpen}
        campaignId={campaignId}
        onClose={() => navigate(-1)}
        onPreviewReady={handlePreviewReady}
      />

      {/* Step 1: Preview table + mapping dialog */}
      {preview && file && activeStep === 1 && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <CsvPreviewTable preview={preview} />
          <Divider sx={{ my: 2 }} />
          <Button
            variant="outlined"
            onClick={() => setMappingDialogOpen(true)}
            data-testid="import-open-mapping"
          >
            Spalten zuordnen
          </Button>
          <CsvMappingDialog
            open={mappingDialogOpen}
            campaignId={campaignId}
            file={file}
            preview={preview}
            onClose={() => setMappingDialogOpen(false)}
            onImported={handleImported}
          />
        </Paper>
      )}

      {/* Step 2: Result */}
      {activeStep === 2 && importResult && (
        <Paper variant="outlined" sx={{ p: 3 }} data-testid="import-result">
          <Box display="flex" alignItems="center" gap={2} mb={2}>
            <CheckCircleIcon color="success" sx={{ fontSize: 40 }} />
            <Typography variant="h6">Import erfolgreich!</Typography>
          </Box>
          <Alert severity="success" sx={{ mb: 2 }}>
            <strong>{importResult.imported}</strong> Leads importiert
            {importResult.skipped_dnc > 0 && ` · ${importResult.skipped_dnc} DNC übersprungen`}
            {importResult.skipped_duplicate > 0 && ` · ${importResult.skipped_duplicate} Duplikate übersprungen`}
            {` · ${importResult.total_in_file} in Datei`}
          </Alert>
          <Button
            variant="contained"
            onClick={() =>
              navigate(`/campaigns/${campaignId}/leads/${importResult.listId}`)
            }
            data-testid="import-view-leads"
          >
            Leads ansehen
          </Button>
        </Paper>
      )}
    </Box>
  );
}
