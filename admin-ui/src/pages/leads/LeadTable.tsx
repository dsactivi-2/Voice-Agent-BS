import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box, Typography, Table, TableHead, TableBody, TableRow, TableCell,
  Chip, CircularProgress, Alert, Paper, IconButton, Pagination,
  Select, MenuItem, FormControl, InputLabel, TextField,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { axiosClient } from '../../providers/axiosClient';
import { getLeadsInList } from '../../services/api';
import { LeadDispositionMenu } from './LeadDispositionMenu';
import { LEAD_STATUS_COLORS } from '../../theme';
import type { Lead, Disposition, LeadStatus } from '../../types';

const PAGE_SIZE = 50;

export function LeadTable() {
  const { id: campaignId, listId } = useParams<{ id: string; listId: string }>();
  const navigate = useNavigate();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [dispositions, setDispositions] = useState<Disposition[]>([]);
  const [listName, setListName] = useState('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<LeadStatus | ''>('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadLeads = useCallback(async () => {
    if (!campaignId || !listId) return;
    setLoading(true);
    try {
      const { data } = await getLeadsInList(campaignId, listId, {
        page,
        pageSize: PAGE_SIZE,
        status: statusFilter || undefined,
        search: search || undefined,
      });
      setLeads(data.leads);
      setTotal(data.total);
    } catch {
      setError('Leads konnten nicht geladen werden');
    } finally {
      setLoading(false);
    }
  }, [campaignId, listId, page, statusFilter, search]);

  // Load list name + dispositions
  useEffect(() => {
    if (!campaignId || !listId) return;
    axiosClient
      .get<{ list: { name: string } }>(`/campaigns/${campaignId}/lists/${listId}`)
      .then(({ data }) => setListName(data.list.name))
      .catch(() => {/* non-critical */});
    axiosClient
      .get<{ dispositions: Disposition[] }>(`/campaigns/${campaignId}/dispositions`)
      .then(({ data }) => setDispositions(data.dispositions ?? []))
      .catch(() => {/* non-critical */});
  }, [campaignId, listId]);

  useEffect(() => { void loadLeads(); }, [loadLeads]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  if (loading && leads.length === 0)
    return <CircularProgress sx={{ m: 4 }} data-testid="leads-loading" />;
  if (error) return <Alert severity="error">{error}</Alert>;

  return (
    <Box p={3} data-testid="lead-table">
      <Box display="flex" alignItems="center" gap={2} mb={2}>
        <IconButton onClick={() => navigate(-1)} data-testid="leads-back">
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h5">
          {listName || `Liste ${listId}`} — {total} Leads
        </Typography>
      </Box>

      {/* Filters */}
      <Box display="flex" gap={2} mb={2} flexWrap="wrap">
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel>Status</InputLabel>
          <Select
            value={statusFilter}
            label="Status"
            onChange={(e) => { setStatusFilter(e.target.value as LeadStatus | ''); setPage(1); }}
            data-testid="leads-status-filter"
          >
            <MenuItem value="">Alle</MenuItem>
            {(['new','queued','dialing','connected','disposed','dnc','failed'] as LeadStatus[]).map(
              (s) => <MenuItem key={s} value={s}>{s}</MenuItem>
            )}
          </Select>
        </FormControl>
        <TextField
          label="Suche"
          size="small"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          inputProps={{ 'data-testid': 'leads-search' }}
        />
      </Box>

      <Paper variant="outlined">
        <Table size="small" data-testid="leads-table">
          <TableHead>
            <TableRow>
              <TableCell>Telefon</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Disposition</TableCell>
              <TableCell>Aktion</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {leads.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} align="center" data-testid="leads-empty">
                  Keine Leads gefunden
                </TableCell>
              </TableRow>
            )}
            {leads.map((lead) => (
              <TableRow key={lead.id} data-testid={`lead-row-${lead.id}`}>
                <TableCell>{lead.phone_primary}</TableCell>
                <TableCell>
                  {[lead.first_name, lead.last_name].filter(Boolean).join(' ') || '—'}
                </TableCell>
                <TableCell>
                  <Chip
                    label={lead.status}
                    size="small"
                    sx={{
                      backgroundColor: LEAD_STATUS_COLORS[lead.status],
                      color: '#fff',
                      fontWeight: 700,
                    }}
                    data-testid={`lead-status-${lead.id}`}
                  />
                </TableCell>
                <TableCell>{lead.disposition_code ?? '—'}</TableCell>
                <TableCell>
                  <LeadDispositionMenu
                    lead={lead}
                    dispositions={dispositions}
                    onUpdated={() => void loadLeads()}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      {totalPages > 1 && (
        <Box display="flex" justifyContent="center" mt={2}>
          <Pagination
            count={totalPages}
            page={page}
            onChange={(_, p) => setPage(p)}
            data-testid="leads-pagination"
          />
        </Box>
      )}
    </Box>
  );
}
