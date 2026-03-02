import { Box, Typography, TextField, Paper } from '@mui/material';
import { useState } from 'react';
import { SseEventLog } from '../../components/SseEventLog';

export function EventList() {
  const [callIdFilter, setCallIdFilter] = useState('');

  return (
    <Box p={3} data-testid="event-list">
      <Typography variant="h5" gutterBottom>
        Live Events (SSE)
      </Typography>
      <Typography variant="body2" color="text.secondary" gutterBottom>
        Echtzeit-Stream über Server-Sent Events (fetch-event-source mit Authorization Header)
      </Typography>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <TextField
          label="Nach callId filtern (optional)"
          value={callIdFilter}
          onChange={(e) => setCallIdFilter(e.target.value)}
          size="small"
          sx={{ width: 320 }}
          inputProps={{ 'data-testid': 'sse-callidfilter' }}
        />
      </Paper>

      <SseEventLog
        callId={callIdFilter.trim() || undefined}
        maxEvents={200}
      />
    </Box>
  );
}
