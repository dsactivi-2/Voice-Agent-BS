import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod/v4';
import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { authenticate } from '../middleware/auth.js';
import { query } from '../db/pool.js';

// ─── Schemas ──────────────────────────────────────────────────────────────

const testCallBodySchema = z.object({
  profile: z.enum(['interested', 'skeptical', 'busy', 'difficult']).default('interested'),
  phoneNumber: z.string().optional(),
  agentId: z.string().uuid().optional(),
  maxDuration: z.coerce.number().int().positive().min(10).max(600).default(120),
});

type TestCallBody = z.infer<typeof testCallBodySchema>;

interface TestCallResult {
  success: boolean;
  callId: string;
  profile: string;
  phoneNumber: string;
  agent: string;
  duration: number;
  turns: number;
  transcript: Array<{ speaker: 'agent' | 'customer'; text: string }>;
  metrics: {
    totalDuration: number;
    ttsLatency: number;
    asrAccuracy: number;
    turnCount: number;
  };
  outcome: string;
  startedAt: string;
  completedAt: string;
}

// ─── Docker Execution ─────────────────────────────────────────────────────

/**
 * Execute the test-call Docker container and parse its JSON output.
 * Throws on execution errors or non-zero exit codes.
 */
async function executeTestCall(
  profile: string,
  callId?: string,
): Promise<TestCallResult> {
  return new Promise((resolve, reject) => {
    const args = ['run', '--rm', '--network', 'voice-system_internal'];

    // Load environment from host .env
    const env = { ...process.env };

    // Pass environment variables
    args.push('-e', 'ORCHESTRATOR_HOST=orchestrator');
    args.push('-e', 'ORCHESTRATOR_PORT=3000');

    if (env['AZURE_SPEECH_KEY']) {
      args.push('-e', `AZURE_SPEECH_KEY=${env['AZURE_SPEECH_KEY']}`);
    }
    if (env['AZURE_REGION']) {
      args.push('-e', `AZURE_REGION=${env['AZURE_REGION']}`);
    }

    // Image and command
    args.push('callagent-test-customer:local');
    args.push('--profile', profile);

    if (callId) {
      args.push('--call-id', callId);
    }

    const startTime = Date.now();
    logger.info({ profile, callId, args }, 'Executing test call via Docker');

    const proc = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      // Log stderr in real-time for debugging
      logger.debug({ stderr: chunk.toString().trim() }, 'Docker stderr');
    });

    proc.on('error', (err) => {
      logger.error({ err, profile }, 'Docker spawn error');
      reject(new Error(`Failed to spawn Docker: ${err.message}`));
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;

      if (code !== 0) {
        logger.error({ code, stderr, stdout, duration }, 'Docker process exited with error');
        reject(new Error(`Docker exited with code ${code}: ${stderr || stdout}`));
        return;
      }

      logger.info({ profile, duration }, 'Docker process completed successfully');

      // Parse JSON output from stdout
      try {
        const result = JSON.parse(stdout) as TestCallResult;
        resolve(result);
      } catch (parseErr) {
        logger.error({ parseErr, stdout, stderr }, 'Failed to parse Docker output');
        reject(new Error(`Invalid JSON output from Docker: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`));
      }
    });
  });
}

// ─── DB Queries ───────────────────────────────────────────────────────────

interface AgentRow {
  id: string;
  name: string;
  language: string;
  tts_voice: string;
}

/**
 * Fetch agent details by ID or default to first agent.
 */
async function getAgent(agentId?: string): Promise<AgentRow | null> {
  const sql = agentId
    ? 'SELECT id, name, language, tts_voice FROM ai_agents WHERE id = $1 LIMIT 1'
    : 'SELECT id, name, language, tts_voice FROM ai_agents ORDER BY id ASC LIMIT 1';

  const values = agentId ? [agentId] : [];

  try {
    const result = await query<AgentRow>(sql, values);
    return result.rows[0] ?? null;
  } catch (err) {
    logger.error({ err, agentId }, 'Database error fetching agent');
    throw new Error('Failed to fetch agent from database');
  }
}

// ─── Route Handler ────────────────────────────────────────────────────────

async function testCallHandler(
  request: FastifyRequest<{ Body: TestCallBody }>,
  reply: FastifyReply,
): Promise<void> {
  const parseResult = testCallBodySchema.safeParse(request.body);

  if (!parseResult.success) {
    await reply.code(400).send({
      error: 'Validation failed',
      code: 'INVALID_BODY',
      details: z.treeifyError(parseResult.error),
    });
    return;
  }

  const { profile, phoneNumber, agentId, maxDuration } = parseResult.data;

  // Fetch agent details
  const agent = await getAgent(agentId);

  if (!agent) {
    await reply.code(404).send({
      error: 'Agent not found',
      code: 'AGENT_NOT_FOUND',
    });
    return;
  }

  logger.info(
    { profile, agentId: agent.id, agentName: agent.name, maxDuration, userId: request.user?.userId },
    'Test call requested',
  );

  try {
    // Execute Docker container
    const result = await executeTestCall(profile);

    logger.info(
      { callId: result.callId, duration: result.duration, turns: result.turns, outcome: result.outcome },
      'Test call completed successfully',
    );

    await reply.code(200).send({
      ...result,
      agentUsed: {
        id: agent.id,
        name: agent.name,
        language: agent.language,
        ttsVoice: agent.tts_voice,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, profile, agent: agent.name }, 'Test call execution failed');

    await reply.code(500).send({
      error: 'Test call execution failed',
      code: 'EXECUTION_ERROR',
      message,
    });
  }
}

// ─── Route Registration ───────────────────────────────────────────────────

export async function testCallRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: TestCallBody }>(
    '/api/test-call',
    {
      preHandler: authenticate,
    },
    testCallHandler,
  );
}
