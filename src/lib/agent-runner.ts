/**
 * Agent Runner Engine
 * Manages agent lifecycle: polls for assigned tasks, executes via OpenClaw CLI.
 * Delegates all LLM work to OpenClaw's existing model connections and sessions.
 */
import { execSync } from "child_process";
import { getAgentById } from "@/operations/agent-ops";
import { listTasks, updateTask, claimTask, releaseTask } from "@/lib/kanban-db";
import { resolveDependencies } from "@/lib/dependency-resolver";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunnerConfig {
  agentId: string;
  model: string;
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
}>();

// ---------------------------------------------------------------------------
// Core: execute a single task via OpenClaw CLI
// ---------------------------------------------------------------------------

function executeTaskViaCron(
  agentId: string,
  taskId: string,
  taskTitle: string,
  taskDescription: string | null,
  model?: string,
): { success: boolean; result: string; cronJobId?: string } {
  const prompt = [
    `You are executing Kanban task "${taskTitle}" (ID: ${taskId}).`,
    taskDescription ? `\nDescription:\n${taskDescription}` : "",
    `\nComplete this task. When done, summarize what you accomplished.`,
  ].join("");

  // Escape single quotes for shell
  const safePrompt = prompt.replace(/'/g, "'\\''");
  const safeName = `Task: ${taskTitle.slice(0, 50)}`.replace(/'/g, "'\\''");

  // Build openclaw cron command for one-shot isolated execution
  const parts = [
    "openclaw cron add",
    `--name '${safeName}'`,
    `--at '1m'`,
    `--session isolated`,
    `--message '${safePrompt}'`,
    `--delete-after-run`,
  ];

  if (model) {
    parts.push(`--model '${model}'`);
  }

  const cmd = parts.join(" ");

  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env },
    });

    // Try to extract the cron job ID from output
    const idMatch = output.match(/(?:id|ID|job)[:\s]+([a-zA-Z0-9_-]+)/);
    const cronJobId = idMatch?.[1];

    return {
      success: true,
      result: `Task dispatched to OpenClaw session. ${cronJobId ? `Cron job: ${cronJobId}` : ""}`.trim(),
      cronJobId: cronJobId || undefined,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to dispatch task via OpenClaw";
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

    console.log(`[agent-runner] Agent "${agentId}" dispatching task "${task.title}" (${task.id})`);

    // 5. Execute via OpenClaw CLI (one-shot isolated cron session)
    const result = executeTaskViaCron(
      agentId,
      task.id,
      task.title,
      task.description,
      runner.config.model,
    );

    // 6. Update task with result
    if (result.success) {
      updateTask(task.id, {
        executionStatus: "success",
        executionResult: result.result,
        status: "done",
      });
      runner.state.tasksCompleted++;
      console.log(`[agent-runner] Agent "${agentId}" dispatched task "${task.title}"`);
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
 * Delegates task execution to OpenClaw via isolated cron sessions.
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
    model: overrides?.model || agent.model || "",
    pollIntervalMs: overrides?.pollIntervalMs || 30_000,
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

  // Validate OpenClaw CLI is available
  try {
    execSync("openclaw --version 2>/dev/null", { encoding: "utf-8", timeout: 5000 });
  } catch {
    return { success: false, error: "OpenClaw CLI not found. Make sure 'openclaw' is installed and in PATH." };
  }

  const runner = { config, state, timer: null as ReturnType<typeof setInterval> | null };
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

  console.log(`[agent-runner] Started agent "${agentId}" (model: ${config.model || "default"}, poll: ${config.pollIntervalMs}ms)`);
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

  // Release any claimed task
  if (runner.state.currentTaskId) {
    try {
      releaseTask(runner.state.currentTaskId, agentId);
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
