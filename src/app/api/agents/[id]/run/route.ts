/**
 * Agent Run API - Start/Stop agent execution
 */
import { NextRequest, NextResponse } from "next/server";
import { startAgent, stopAgent, getRunnerState, isAgentRunning } from "@/lib/agent-runner";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/agents/[id]/run - Get agent runner status
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const running = isAgentRunning(id);
  const state = getRunnerState(id);

  return NextResponse.json({
    agentId: id,
    running,
    ...(state ? { config: state.config, state: state.state } : {}),
  });
}

// POST /api/agents/[id]/run - Start agent
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      // empty body is fine
    }

    const result = await startAgent(id, {
      model: body.model as string | undefined,
      pollIntervalMs: body.pollIntervalMs as number | undefined,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    const state = getRunnerState(id);
    return NextResponse.json({
      success: true,
      agentId: id,
      message: `Agent "${id}" started`,
      ...(state ? { config: state.config, state: state.state } : {}),
    });
  } catch (error) {
    console.error("[api/agents/[id]/run] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start agent" },
      { status: 500 },
    );
  }
}

// DELETE /api/agents/[id]/run - Stop agent
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const result = stopAgent(id);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      agentId: id,
      message: `Agent "${id}" stopped`,
    });
  } catch (error) {
    console.error("[api/agents/[id]/run] DELETE error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to stop agent" },
      { status: 500 },
    );
  }
}
