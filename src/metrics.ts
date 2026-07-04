export interface ToolMetrics {
  calls: number;
  errors: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export interface MetricsSnapshot {
  uptimeSeconds: number;
  totals: ToolMetrics;
  perTool: Record<string, ToolMetrics>;
}

function emptyMetrics(): ToolMetrics {
  return { calls: 0, errors: 0, totalDurationMs: 0, maxDurationMs: 0 };
}

/** In-process counters for tool call volume, errors, and latency. */
export class MetricsRegistry {
  private readonly startedAt = Date.now();
  private readonly totals = emptyMetrics();
  private readonly perTool = new Map<string, ToolMetrics>();

  record(tool: string, durationMs: number, ok: boolean): void {
    for (const metrics of [this.totals, this.toolMetrics(tool)]) {
      metrics.calls += 1;
      if (!ok) metrics.errors += 1;
      metrics.totalDurationMs += durationMs;
      metrics.maxDurationMs = Math.max(metrics.maxDurationMs, durationMs);
    }
  }

  private toolMetrics(tool: string): ToolMetrics {
    let metrics = this.perTool.get(tool);
    if (!metrics) {
      metrics = emptyMetrics();
      this.perTool.set(tool, metrics);
    }
    return metrics;
  }

  snapshot(): MetricsSnapshot {
    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      totals: { ...this.totals },
      perTool: Object.fromEntries([...this.perTool].map(([tool, m]) => [tool, { ...m }])),
    };
  }
}
