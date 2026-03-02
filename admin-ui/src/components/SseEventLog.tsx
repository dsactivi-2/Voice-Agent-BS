import { useEffect, useRef, useState } from 'react';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import {
  Box,
  Typography,
  Chip,
  List,
  ListItem,
  Paper,
  Alert,
  IconButton,
  Tooltip,
} from '@mui/material';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import type { SseEvent } from '../types';
import { SSE_URL } from '../services/api';

interface SseEventLogProps {
  callId?: string;
  maxEvents?: number;
}

export function SseEventLog({ callId, maxEvents = 100 }: SseEventLogProps) {
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const token = localStorage.getItem('accessToken');
    const url = callId ? `${SSE_URL}?callId=${callId}` : SSE_URL;

    void fetchEventSource(url, {
      headers: {
        // fetch-event-source erlaubt Authorization Header — native EventSource nicht!
        Authorization: `Bearer ${token ?? ''}`,
      },
      signal: ctrl.signal,
      openWhenHidden: true,
      onopen: async (response) => {
        if (response.ok) {
          setConnected(true);
          setError(null);
          return;
        }
        if (response.status === 401) {
          setError('Authentifizierung fehlgeschlagen (401)');
          ctrl.abort();
        } else {
          setError(`Verbindung fehlgeschlagen (${response.status})`);
        }
      },
      onmessage: (event) => {
        // Heartbeat ignorieren: ": ping"
        if (!event.data || event.data.startsWith(':')) return;
        try {
          const parsed = JSON.parse(event.data) as SseEvent;
          setEvents((prev) => [parsed, ...prev].slice(0, maxEvents));
        } catch {
          // malformed — ignore
        }
      },
      onerror: () => {
        setConnected(false);
        setError('Verbindung unterbrochen — reconnecting...');
        // fetch-event-source reconnects automatisch
      },
    });

    return () => {
      ctrl.abort();
      setConnected(false);
    };
  }, [callId, maxEvents]);

  const clearEvents = () => setEvents([]);

  return (
    <Box data-testid="sse-event-log">
      <Box display="flex" alignItems="center" gap={1} mb={1}>
        <Chip
          size="small"
          label={connected ? 'LIVE' : 'OFFLINE'}
          color={connected ? 'success' : 'error'}
          data-testid="sse-connection-status"
        />
        <Typography variant="body2" color="text.secondary">
          {events.length} Events
          {callId && ` | Filter: callId=${callId}`}
        </Typography>
        <Tooltip title="Events löschen">
          <IconButton size="small" onClick={clearEvents} data-testid="sse-clear-btn">
            <DeleteSweepIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 1 }} data-testid="sse-error">
          {error}
        </Alert>
      )}

      <Paper
        variant="outlined"
        sx={{
          maxHeight: 500,
          overflowY: 'auto',
          fontFamily: 'monospace',
          fontSize: '0.78rem',
          bgcolor: 'background.default',
        }}
      >
        <List dense disablePadding>
          {events.length === 0 && (
            <ListItem data-testid="sse-empty">
              <Typography variant="caption" color="text.secondary">
                Warte auf Events...
              </Typography>
            </ListItem>
          )}
          {events.map((ev, i) => (
            <ListItem
              key={`${ev.ts ?? i}-${i}`}
              divider
              data-testid={`sse-event-${i}`}
              sx={{ alignItems: 'flex-start', py: 0.5 }}
            >
              <Box>
                <Typography component="span" sx={{ color: 'primary.main', fontWeight: 700 }}>
                  {ev.type}
                </Typography>
                {ev.callId && (
                  <Typography component="span" sx={{ ml: 1, color: 'text.secondary' }}>
                    callId={ev.callId}
                  </Typography>
                )}
                <Typography component="span" sx={{ ml: 1, color: 'text.disabled', fontSize: '0.7rem' }}>
                  {ev.ts ? new Date(ev.ts).toLocaleTimeString() : ''}
                </Typography>
                <Typography
                  component="pre"
                  sx={{ mt: 0.25, color: 'text.secondary', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                >
                  {JSON.stringify(ev, null, 2)}
                </Typography>
              </Box>
            </ListItem>
          ))}
        </List>
      </Paper>
    </Box>
  );
}
