import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, Table, TableHead, TableBody, TableRow, TableCell,
  IconButton, Chip, CircularProgress, Alert, Paper, Tab, Tabs, TextField,
  Select, MenuItem, FormControl, InputLabel, Divider,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteIcon from '@mui/icons-material/Delete';
import SearchIcon from '@mui/icons-material/Search';
import { useNotify } from 'react-admin';
import {
  getKbDocuments,
  addKbDocument,
  uploadKbPdf,
  deleteKbDocument,
  searchKb,
} from '../../services/api';
import type { KbDocument } from '../../types';

export function KbDocuments() {
  const { id: kbId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const notify = useNotify();
  const pdfInputRef = useRef<HTMLInputElement>(null);

  const [documents, setDocuments] = useState<KbDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);

  // Add text/url form
  const [sourceType, setSourceType] = useState<'text' | 'url'>('text');
  const [content, setContent] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [addLoading, setAddLoading] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<{ content: string; score: number }>>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  const load = async () => {
    if (!kbId) return;
    setLoading(true);
    try {
      const { data } = await getKbDocuments(kbId);
      setDocuments(data.documents ?? []);
    } catch {
      setError('Dokumente konnten nicht geladen werden');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [kbId]); // load is intentionally excluded

  const handleAddDoc = async () => {
    if (!kbId) return;
    setAddLoading(true);
    try {
      await addKbDocument(kbId, {
        source_type: sourceType,
        content: sourceType === 'text' ? content : undefined,
        source_url: sourceType === 'url' ? sourceUrl : undefined,
        filename: filename || undefined,
      });
      notify('Dokument wird verarbeitet (async)', { type: 'success' });
      setContent('');
      setSourceUrl('');
      setFilename('');
      void load();
    } catch {
      notify('Fehler beim Hinzufügen', { type: 'error' });
    } finally {
      setAddLoading(false);
    }
  };

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !kbId) return;
    setAddLoading(true);
    try {
      await uploadKbPdf(kbId, file);
      notify('PDF wird verarbeitet (async)', { type: 'success' });
      void load();
    } catch {
      notify('PDF-Upload fehlgeschlagen', { type: 'error' });
    } finally {
      setAddLoading(false);
      e.target.value = '';
    }
  };

  const handleDelete = async (docId: string) => {
    if (!kbId) return;
    if (!confirm('Dokument löschen?')) return;
    try {
      await deleteKbDocument(kbId, docId);
      notify('Dokument gelöscht', { type: 'success' });
      void load();
    } catch {
      notify('Löschen fehlgeschlagen', { type: 'error' });
    }
  };

  const handleSearch = async () => {
    if (!kbId || !searchQuery.trim()) return;
    setSearchLoading(true);
    setSearchError(null);
    setSearchResults([]);
    try {
      const { data } = await searchKb(kbId, searchQuery.trim());
      setSearchResults(data.results ?? []);
    } catch (err: unknown) {
      const axErr = err as { response?: { status?: number } };
      if (axErr?.response?.status === 500) {
        setSearchError('Suche nicht verfügbar — pgvector ist auf dem Server nicht installiert.');
      } else {
        setSearchError('Suche fehlgeschlagen');
      }
    } finally {
      setSearchLoading(false);
    }
  };

  if (loading) return <CircularProgress sx={{ m: 4 }} data-testid="kb-docs-loading" />;
  if (error) return <Alert severity="error">{error}</Alert>;

  return (
    <Box p={3} data-testid="kb-documents">
      <Box display="flex" alignItems="center" gap={2} mb={3}>
        <IconButton onClick={() => navigate(-1)} data-testid="kb-docs-back">
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h5">Dokumente — KB {kbId}</Typography>
      </Box>

      <Tabs value={tab} onChange={(_, v: number) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Dokumente" data-testid="kb-tab-docs" />
        <Tab label="Hinzufügen" data-testid="kb-tab-add" />
        <Tab label="Suche" data-testid="kb-tab-search" />
      </Tabs>

      {/* ── TAB 0: Dokumente ── */}
      {tab === 0 && (
        <Paper variant="outlined">
          <Table size="small" data-testid="kb-docs-table">
            <TableHead>
              <TableRow>
                <TableCell>Typ</TableCell>
                <TableCell>Datei / URL</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Aktion</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {documents.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} align="center" data-testid="kb-docs-empty">
                    Keine Dokumente vorhanden
                  </TableCell>
                </TableRow>
              )}
              {documents.map((doc) => (
                <TableRow key={doc.id} data-testid={`kb-doc-row-${doc.id}`}>
                  <TableCell>
                    <Chip label={doc.source_type} size="small" />
                  </TableCell>
                  <TableCell>{doc.filename ?? doc.source_url ?? '—'}</TableCell>
                  <TableCell>
                    <Chip
                      label={doc.status}
                      size="small"
                      color={
                        doc.status === 'ready'
                          ? 'success'
                          : doc.status === 'error'
                          ? 'error'
                          : 'warning'
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <IconButton
                      size="small"
                      color="error"
                      onClick={() => void handleDelete(doc.id)}
                      data-testid={`kb-doc-delete-${doc.id}`}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}

      {/* ── TAB 1: Hinzufügen ── */}
      {tab === 1 && (
        <Box data-testid="kb-add-form">
          <Box display="flex" gap={2} flexWrap="wrap" mb={2}>
            {/* Text / URL form */}
            <Paper variant="outlined" sx={{ p: 2, flex: 1, minWidth: 300 }}>
              <Typography variant="subtitle1" gutterBottom>Text oder URL</Typography>
              <FormControl fullWidth sx={{ mb: 2 }}>
                <InputLabel>Typ</InputLabel>
                <Select
                  value={sourceType}
                  label="Typ"
                  onChange={(e) => setSourceType(e.target.value as 'text' | 'url')}
                  inputProps={{ 'data-testid': 'kb-add-source-type' }}
                >
                  <MenuItem value="text">Text</MenuItem>
                  <MenuItem value="url">URL</MenuItem>
                </Select>
              </FormControl>
              {sourceType === 'text' ? (
                <TextField
                  label="Textinhalt"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  multiline
                  minRows={4}
                  fullWidth
                  sx={{ mb: 2 }}
                  inputProps={{ 'data-testid': 'kb-add-content' }}
                />
              ) : (
                <TextField
                  label="URL"
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  fullWidth
                  sx={{ mb: 2 }}
                  inputProps={{ 'data-testid': 'kb-add-url' }}
                />
              )}
              <TextField
                label="Dateiname (optional)"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                fullWidth
                sx={{ mb: 2 }}
                inputProps={{ 'data-testid': 'kb-add-filename' }}
              />
              <Button
                variant="contained"
                disabled={
                  addLoading ||
                  (sourceType === 'text' ? !content.trim() : !sourceUrl.trim())
                }
                onClick={() => void handleAddDoc()}
                data-testid="kb-add-submit"
              >
                {addLoading ? <CircularProgress size={20} /> : 'Hinzufügen'}
              </Button>
            </Paper>

            {/* PDF upload */}
            <Paper variant="outlined" sx={{ p: 2, flex: 1, minWidth: 300 }}>
              <Typography variant="subtitle1" gutterBottom>PDF Upload (max. 50 MB)</Typography>
              <Divider sx={{ mb: 2 }} />
              <Button
                variant="outlined"
                disabled={addLoading}
                onClick={() => pdfInputRef.current?.click()}
                data-testid="kb-pdf-upload-btn"
              >
                {addLoading ? <CircularProgress size={20} /> : 'PDF auswählen'}
              </Button>
              <input
                ref={pdfInputRef}
                type="file"
                accept=".pdf"
                style={{ display: 'none' }}
                onChange={(e) => void handlePdfUpload(e)}
                data-testid="kb-pdf-input"
              />
              <Typography variant="caption" display="block" sx={{ mt: 1 }} color="text.secondary">
                Verarbeitung erfolgt asynchron (status: processing → ready)
              </Typography>
            </Paper>
          </Box>
        </Box>
      )}

      {/* ── TAB 2: Suche ── */}
      {tab === 2 && (
        <Box data-testid="kb-search">
          <Alert severity="info" sx={{ mb: 2 }}>
            Semantische Suche benötigt pgvector auf dem Server.
            Ohne pgvector: 500 Error.
          </Alert>
          <Box display="flex" gap={2} mb={2}>
            <TextField
              label="Suchanfrage"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              fullWidth
              inputProps={{ 'data-testid': 'kb-search-query' }}
            />
            <Button
              variant="contained"
              startIcon={searchLoading ? <CircularProgress size={16} /> : <SearchIcon />}
              disabled={!searchQuery.trim() || searchLoading}
              onClick={() => void handleSearch()}
              data-testid="kb-search-submit"
            >
              Suchen
            </Button>
          </Box>
          {searchError && (
            <Alert severity="error" data-testid="kb-search-error">{searchError}</Alert>
          )}
          {searchResults.map((r, i) => (
            <Paper key={i} variant="outlined" sx={{ p: 2, mb: 1 }} data-testid={`kb-search-result-${i}`}>
              <Typography variant="caption" color="text.secondary">
                Score: {r.score.toFixed(3)}
              </Typography>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                {r.content}
              </Typography>
            </Paper>
          ))}
        </Box>
      )}
    </Box>
  );
}
