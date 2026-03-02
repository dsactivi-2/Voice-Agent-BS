import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, Table, TableHead, TableBody,
  TableRow, TableCell, IconButton, CircularProgress, Alert,
  Paper,
} from '@mui/material';
import VisibilityIcon from '@mui/icons-material/Visibility';
import DeleteIcon from '@mui/icons-material/Delete';
import UploadIcon from '@mui/icons-material/Upload';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useNotify } from 'react-admin';
import { axiosClient } from '../../providers/axiosClient';
import type { LeadList } from '../../types';

export function LeadListsByCampaign() {
  const { id: campaignId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const notify = useNotify();

  const [lists, setLists] = useState<LeadList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!campaignId) return;
    setLoading(true);
    try {
      const { data } = await axiosClient.get<{ lists: LeadList[] }>(
        `/campaigns/${campaignId}/lists`
      );
      setLists(data.lists ?? []);
    } catch {
      setError('Lead-Listen konnten nicht geladen werden');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [campaignId]); // load is intentionally excluded

  const handleDelete = async (listId: string) => {
    if (!campaignId) return;
    if (!confirm('Liste löschen? Alle Leads werden gelöscht (cascade)!')) return;
    try {
      await axiosClient.delete(`/campaigns/${campaignId}/lists/${listId}`);
      notify('Liste gelöscht', { type: 'success' });
      void load();
    } catch {
      notify('Löschen fehlgeschlagen', { type: 'error' });
    }
  };

  if (loading) return <CircularProgress sx={{ m: 4 }} data-testid="lists-loading" />;
  if (error) return <Alert severity="error">{error}</Alert>;

  return (
    <Box p={3} data-testid="lead-lists">
      <Box display="flex" alignItems="center" gap={2} mb={3}>
        <IconButton onClick={() => navigate(-1)} data-testid="lists-back">
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h5">Lead-Listen — Campaign {campaignId}</Typography>
        <Button
          variant="contained"
          startIcon={<UploadIcon />}
          onClick={() => navigate(`/campaigns/${campaignId}/import-leads`)}
          data-testid="lists-import-btn"
          sx={{ ml: 'auto' }}
        >
          CSV importieren
        </Button>
      </Box>

      <Paper variant="outlined">
        <Table size="small" data-testid="lists-table">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Leads</TableCell>
              <TableCell>Importiert am</TableCell>
              <TableCell>Aktionen</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {lists.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} align="center" data-testid="lists-empty">
                  Keine Lead-Listen vorhanden
                </TableCell>
              </TableRow>
            )}
            {lists.map((list) => (
              <TableRow key={list.id} data-testid={`list-row-${list.id}`}>
                <TableCell>{list.name}</TableCell>
                <TableCell>{list.total_leads}</TableCell>
                <TableCell>{new Date(list.imported_at).toLocaleDateString('de-DE')}</TableCell>
                <TableCell>
                  <IconButton
                    size="small"
                    onClick={() =>
                      navigate(`/campaigns/${campaignId}/leads/${list.id}`)
                    }
                    data-testid={`list-view-${list.id}`}
                  >
                    <VisibilityIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    color="error"
                    onClick={() => void handleDelete(list.id)}
                    data-testid={`list-delete-${list.id}`}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
}
