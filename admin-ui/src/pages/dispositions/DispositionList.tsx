import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Button,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  IconButton,
  Chip,
  CircularProgress,
  Alert,
  Paper,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useNotify } from 'react-admin';
import { axiosClient } from '../../providers/axiosClient';
import { DispositionEditModal } from '../../components/DispositionEditModal';
import type { Disposition } from '../../types';

export function DispositionList() {
  const { id: campaignId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const notify = useNotify();

  const [dispositions, setDispositions] = useState<Disposition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editDisposition, setEditDisposition] = useState<Disposition | null>(null);

  const load = async () => {
    if (!campaignId) return;
    setLoading(true);
    try {
      const { data } = await axiosClient.get<{ dispositions: Disposition[] }>(
        `/campaigns/${campaignId}/dispositions`
      );
      setDispositions(data.dispositions ?? []);
    } catch {
      setError('Dispositions konnten nicht geladen werden');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [campaignId]); // eslint-disable-line

  const handleDelete = async (dispId: string) => {
    if (!campaignId) return;
    if (!confirm('Disposition wirklich löschen?')) return;
    try {
      await axiosClient.delete(`/campaigns/${campaignId}/dispositions/${dispId}`);
      notify('Disposition gelöscht', { type: 'success' });
      void load();
    } catch {
      notify('Löschen fehlgeschlagen', { type: 'error' });
    }
  };

  if (loading) return <CircularProgress sx={{ m: 4 }} data-testid="disp-loading" />;
  if (error) return <Alert severity="error" data-testid="disp-error">{error}</Alert>;

  return (
    <Box p={3} data-testid="disposition-list">
      <Box display="flex" alignItems="center" gap={2} mb={3}>
        <IconButton onClick={() => navigate(-1)} data-testid="disp-back">
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h5">Dispositions — Campaign {campaignId}</Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => navigate(`/campaigns/${campaignId}/dispositions/create`)}
          data-testid="disp-create-btn"
          sx={{ ml: 'auto' }}
        >
          Neu
        </Button>
      </Box>

      <Paper variant="outlined">
        <Table size="small" data-testid="disp-table">
          <TableHead>
            <TableRow>
              <TableCell>Code</TableCell>
              <TableCell>Label</TableCell>
              <TableCell>Erfolg</TableCell>
              <TableCell>DNC</TableCell>
              <TableCell>Retry</TableCell>
              <TableCell>Sort</TableCell>
              <TableCell>Aktionen</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {dispositions.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} align="center" data-testid="disp-empty">
                  Keine Dispositions vorhanden
                </TableCell>
              </TableRow>
            )}
            {dispositions.map((d) => (
              <TableRow key={d.id} data-testid={`disp-row-${d.id}`}>
                <TableCell>
                  <Chip label={d.code} size="small" variant="outlined" />
                </TableCell>
                <TableCell>{d.label}</TableCell>
                <TableCell>
                  {d.is_success ? (
                    <Chip label="Ja" size="small" color="success" />
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>
                  {d.is_dnc ? (
                    <Chip label="DNC" size="small" color="error" />
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>{d.retry_allowed ? `${d.retry_after_hours}h` : 'Nein'}</TableCell>
                <TableCell>{d.sort_order}</TableCell>
                <TableCell>
                  <IconButton
                    size="small"
                    onClick={() => setEditDisposition(d)}
                    data-testid={`disp-edit-${d.id}`}
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    color="error"
                    onClick={() => void handleDelete(d.id)}
                    data-testid={`disp-delete-${d.id}`}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      {editDisposition && campaignId && (
        <DispositionEditModal
          open
          onClose={() => setEditDisposition(null)}
          campaignId={campaignId}
          disposition={editDisposition}
        />
      )}
    </Box>
  );
}
