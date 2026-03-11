/**
 * Running Agents API - List all currently running agents
 */
import { NextResponse } from "next/server";
import { listRunningAgents } from "@/lib/agent-runner";

export const dynamic = "force-dynamic";

export async function GET() {
  const runners = listRunningAgents();
  return NextResponse.json({
    count: runners.length,
    agents: runners.map(r => ({
      agentId: r.config.agentId,
      model: r.config.model,
      status: r.state.status,
      startedAt: r.state.startedAt,
      lastPollAt: r.state.lastPollAt,
      currentTaskId: r.state.currentTaskId,
      tasksCompleted: r.state.tasksCompleted,
      tasksFailed: r.state.tasksFailed,
      error: r.state.error,
    })),
  });
}
