/**
 * Agent Runner Engine
 * Manages agent lifecycle: polls for assigned tasks, executes via LLM, updates status.
 * Uses OpenRouter (OpenAI-compatible API) for LLM calls.
 */
import OpenAI from "openai";
import { getAgentById } from "@/operations/agent-ops";
import { listTasks, updateTask, claimTask, releaseTask, getTask } from "@/lib/kanban-db";
import { resolveDependencies } from "@/lib/dependency-resolver";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunnerConfig {
  agentId: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  skills: string[];
  pollIntervalMs: number;
}

interface RunnerState {
  status: "idle" | "polling" | "executing" | "stopped";
  currentTaskId: string | null;
  startedAt: string | null;
  lastPollAt: string | null;
  tasksCompleted: number;
  tasksFailed: number;
  error: string | null;
}

export interface AgentRunner {
  config: RunnerConfig;
  state: RunnerState;
}

// ---------------------------------------------------------------------------
// Registry of active runners
// ---------------------------------------------------------------------------

const activeRunners = new Map<string, {
  config: RunnerConfig;
  state: RunnerState;
  timer: ReturnType<typeof setInterval> | null;
  abortController: AbortController | null;
}>();

// ---------------------------------------------------------------------------
// OpenRouter client (lazy init)
// ---------------------------------------------------------------------------

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY or OPENAI_API_KEY env var is required to run agents");
    }

    const baseURL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

    openaiClient = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: {
        "HTTP-Referer": "https://openclaw.ai",
        "X-Title": "OpenClaw Agent Runner",
      },
    });
  }
  return openaiClient;
}

// ---------------------------------------------------------------------------
// Core: execute a single task via LLM
// ---------------------------------------------------------------------------

async function executeTask(
  config: RunnerConfig,
  taskId: string,
  taskTitle: string,
  taskDescription: string | null,
  signal: AbortSignal,
): Promise<{ success: boolean; result: string }> {
  const client = getClient();

  const userMessage = [
    `## Task: ${taskTitle}`,
    taskDescription ? `\n${taskDescription}` : "",
    `\nComplete this task. Be concise and actionable in your response.`,
  ].join("");

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: config.systemPrompt || "You are a helpful agent. Complete tasks efficiently." },
    { role: "user", content: userMessage },
  ];

  try {
    const response = await client.chat.completions.create(
      {
        model: config.model,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
      },
      { signal },
    );

    const content = response.choices?.[0]?.message?.content || "(no response)";
    return { success: true, result: content };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { success: false, result: "Task execution was cancelled" };
    }
    const msg = err instanceof Error ? err.message : "Unknown LLM error";
    return { success: false, result: msg };
  }
}

// ---------------------------------------------------------------------------
// Poll cycle: fetch tasks → claim → execute → update
// ---------------------------------------------------------------------------

async function pollCycle(agentId: string): Promise<void> {
  const runner = activeRunners.get(agentId);
  if (!runner || runner.state.status === "stopped") return;

  runner.state.status = "polling";
  runner.state.lastPollAt = new Date().toISOString();

  try {
    // 1. Get tasks assigned to this agent with status in_progress
    const tasks = listTasks({ assignee: agentId, status: "in_progress" });
    const available = tasks.filter(t => !t.claimedBy || t.claimedBy === agentId);
    const resolved = resolveDependencies(available);
    const executable = resolved.filter(t => t.isExecutable);

    if (executable.length === 0) {
      runner.state.status = "idle";
      return;
    }

    // 2. Pick highest priority task
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    executable.sort((a, b) =>
      (priorityOrder[a.priority as keyof typeof priorityOrder] ?? 3) -
      (priorityOrder[b.priority as keyof typeof priorityOrder] ?? 3)
    );

    const task = executable[0];

    // 3. Claim it
    const claimResult = claimTask(task.id, agentId);
    if (!claimResult.success) {
      runner.state.status = "idle";
      return;
    }

    // 4. Mark as executing
    runner.state.status = "executing";
    runner.state.currentTaskId = task.id;
    updateTask(task.id, { executionStatus: "running" });

    console.log(`[agent-runner] Agent "${agentId}" executing task "${task.title}" (${task.id})`);

    // 5. Execute via LLM
    runner.abortController = new AbortController();
    const result = await executeTask(
      runner.config,
      task.id,
      task.title,
      task.description,
      runner.abortController.signal,
    );

    // 6. Update task with result
    if (result.success) {
      updateTask(task.id, {
        executionStatus: "success",
        executionResult: result.result,
        status: "done",
      });
      runner.state.tasksCompleted++;
      console.log(`[agent-runner] Agent "${agentId}" completed task "${task.title}"`);
    } else {
      updateTask(task.id, {
        executionStatus: "error",
        executionResult: result.result,
      });
      runner.state.tasksFailed++;
      console.log(`[agent-runner] Agent "${agentId}" failed task "${task.title}": ${result.result}`);
    }

    // 7. Release claim
    releaseTask(task.id, agentId);
    runner.state.currentTaskId = null;
    runner.abortController = null;
    runner.state.status = "idle";

  } catch (err) {
    console.error(`[agent-runner] Poll error for agent "${agentId}":`, err);
    runner.state.status = "idle";
    runner.state.error = err instanceof Error ? err.message : "Unknown poll error";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start an agent runner. Polls for tasks at the configured interval.
 */
export async function startAgent(agentId: string, overrides?: Partial<RunnerConfig>): Promise<{ success: boolean; error?: string }> {
  if (activeRunners.has(agentId)) {
    return { success: false, error: "Agent is already running" };
  }

  // Get agent info
  const agentResult = await getAgentById(agentId);
  if (!agentResult.success || !agentResult.data) {
    return { success: false, error: `Agent "${agentId}" not found` };
  }

  const agent = agentResult.data;

  // Build config from agent data + overrides
  const config: RunnerConfig = {
    agentId,
    model: overrides?.model || agent.model || "anthropic/claude-sonnet-4-20250514",
    systemPrompt: overrides?.systemPrompt || "You are a helpful agent. Complete tasks efficiently and report results clearly.",
    temperature: overrides?.temperature ?? 0.7,
    maxTokens: overrides?.maxTokens ?? 4096,
    skills: overrides?.skills || [],
    pollIntervalMs: overrides?.pollIntervalMs || 30_000, // default 30s
  };

  const state: RunnerState = {
    status: "idle",
    currentTaskId: null,
    startedAt: new Date().toISOString(),
    lastPollAt: null,
    tasksCompleted: 0,
    tasksFailed: 0,
    error: null,
  };

  // Validate LLM client early
  try {
    getClient();
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to init LLM client" };
  }

  const runner = { config, state, timer: null as ReturnType<typeof setInterval> | null, abortController: null as AbortController | null };
  activeRunners.set(agentId, runner);

  // Start polling
  runner.timer = setInterval(() => {
    // Don't start a new poll if already executing
    if (runner.state.status !== "executing") {
      pollCycle(agentId);
    }
  }, config.pollIntervalMs);

  // Run first poll immediately
  pollCycle(agentId);

  console.log(`[agent-runner] Started agent "${agentId}" (model: ${config.model}, poll: ${config.pollIntervalMs}ms)`);
  return { success: true };
}

/**
 * Stop an agent runner.
 */
export function stopAgent(agentId: string): { success: boolean; error?: string } {
  const runner = activeRunners.get(agentId);
  if (!runner) {
    return { success: false, error: "Agent is not running" };
  }

  // Stop polling
  if (runner.timer) {
    clearInterval(runner.timer);
  }

  // Cancel any in-flight LLM call
  if (runner.abortController) {
    runner.abortController.abort();
  }

  // Release any claimed task
  if (runner.state.currentTaskId) {
    try {
      releaseTask(runner.state.currentTaskId, agentId);
      // Reset execution status back to pending
      updateTask(runner.state.currentTaskId, { executionStatus: "pending" });
    } catch {
      // best effort
    }
  }

  runner.state.status = "stopped";
  activeRunners.delete(agentId);

  console.log(`[agent-runner] Stopped agent "${agentId}"`);
  return { success: true };
}

/**
 * Get the current state of a running agent.
 */
export function getRunnerState(agentId: string): AgentRunner | null {
  const runner = activeRunners.get(agentId);
  if (!runner) return null;
  return { config: runner.config, state: runner.state };
}

/**
 * List all running agents.
 */
export function listRunningAgents(): AgentRunner[] {
  return Array.from(activeRunners.values()).map(r => ({
    config: r.config,
    state: r.state,
  }));
}

/**
 * Check if an agent is running.
 */
export function isAgentRunning(agentId: string): boolean {
  return activeRunners.has(agentId);
}
