/**
 * Agent Runner Engine
 * Manages agent lifecycle: polls for assigned tasks, executes via OpenClaw CLI.
 * Delegates all LLM work to OpenClaw's existing model connections and sessions.
 */
import { execSync, exec } from "child_process";
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
// Helpers
// ---------------------------------------------------------------------------

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Core: create a one-shot cron job via OpenClaw CLI
// ---------------------------------------------------------------------------

function createCronJob(
  taskTitle: string,
  taskDescription: string | null,
  model?: string,
): { success: boolean; jobId?: string; error?: string } {
  const message = [
    `## Task: ${taskTitle}`,
    taskDescription ? `\n${taskDescription}` : "",
    `\nComplete this task. Be concise and actionable. Summarize what you accomplished.`,
  ].join("");

  const args: string[] = [
    "openclaw", "cron", "add", "--json",
    "--name", escapeShellArg(`Task: ${taskTitle.slice(0, 50)}`),
    "--at", escapeShellArg("1m"),
    "--session", "isolated",
    "--message", escapeShellArg(message),
    "--description", escapeShellArg(taskDescription || taskTitle),
    "--delete-after-run",
  ];

  if (model) {
    args.push("--model", escapeShellArg(model));
  }

  const command = args.join(" ");

  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: 15_000,
    });

    // Try to parse JSON output first
    try {
      const data = JSON.parse(output);
      const jobId = data.id || data.jobId || data.job?.id;
      if (jobId) {
        return { success: true, jobId };
      }
    } catch {
      // Fall back to regex extraction
    }

    // Extract job ID from output (UUID format)
    const idMatch = output.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
      || output.match(/(?:id|ID|job)[:\s]+([a-zA-Z0-9_-]+)/);
    const jobId = idMatch?.[1];

    if (!jobId) {
      return { success: false, error: `Could not extract job ID from: ${output.trim()}` };
    }

    return { success: true, jobId };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to create cron job";
    return { success: false, error: msg };
  }
}

/**
 * Delete a cron job (cleanup after execution).
 */
function deleteCronJob(jobId: string): void {
  try {
    execSync(`openclaw cron rm ${jobId} 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 10_000,
    });
  } catch {
    // best effort cleanup
  }
}

/**
 * Force-run a cron job and poll for its completion.
 * Returns a promise that resolves when the run finishes.
 */
function forceRunAndWait(
  jobId: string,
  timeoutMs = 300_000, // 5 min max
  pollMs = 5_000,
): Promise<{ success: boolean; result: string }> {
  return new Promise((resolve) => {
    // Force-run the job (async, don't block)
    exec(`openclaw cron run ${jobId} --force 2>&1`, { timeout: 15_000 }, (err) => {
      if (err) {
        console.warn(`[agent-runner] Force-run command returned error (may still work): ${err.message}`);
      }
    });

    const startTime = Date.now();

    // Poll for completion
    const pollTimer = setInterval(() => {
      // Timeout check
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(pollTimer);
        deleteCronJob(jobId);
        resolve({ success: false, result: "Task execution timed out" });
        return;
      }

      try {
        const output = execSync(`openclaw cron runs ${jobId} --json 2>/dev/null`, {
          encoding: "utf-8",
          timeout: 10_000,
        });

        const data = JSON.parse(output);
        const runs = data.runs || data || [];

        if (runs.length === 0) return; // Not started yet

        // Get the most recent run
        const latestRun = runs[0];

        if (latestRun.status === "success") {
          clearInterval(pollTimer);
          deleteCronJob(jobId);
          resolve({
            success: true,
            result: latestRun.summary || latestRun.result || latestRun.output || "Task completed successfully",
          });
        } else if (latestRun.status === "error" || latestRun.status === "failed") {
          clearInterval(pollTimer);
          deleteCronJob(jobId);
          resolve({
            success: false,
            result: latestRun.error || latestRun.result || "Task execution failed",
          });
        }
        // else still running — keep polling
      } catch {
        // Parse error or command failure — keep polling
      }
    }, pollMs);
  });
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

    // 5. Create one-shot cron job
    const cronResult = createCronJob(task.title, task.description, runner.config.model);

    if (!cronResult.success || !cronResult.jobId) {
      updateTask(task.id, {
        executionStatus: "error",
        executionResult: cronResult.error || "Failed to create OpenClaw session",
      });
      runner.state.tasksFailed++;
      releaseTask(task.id, agentId);
      runner.state.currentTaskId = null;
      runner.state.status = "idle";
      return;
    }

    console.log(`[agent-runner] Created cron job ${cronResult.jobId} for task "${task.title}"`);

    // 6. Force-run and wait for actual completion
    const result = await forceRunAndWait(cronResult.jobId);

    // 7. Update task with actual result
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

    // 8. Release claim
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
