export const SBCE_ACTIVE_STATES: readonly string[] = ["queued", "running", "verifying", "fixing"];

export type CompactJob = {
  job_id: string;
  status: string;
  done: boolean;
  attempts: number;
  spent_vnd: number;
  failed_checks: string[];
  last_error: string | null;
  artifact: string | null;
  summary: string | null;
  next: string;
  context_warning?: string;
};

function truncate(value: string, maxText: number): string {
  const limit = Math.max(1, Math.floor(Number(maxText) || 300));
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}

export function compactJob(job: any, maxText = 300): CompactJob {
  const status = String(job?.status ?? "unknown");
  const review = job?.review;
  const checks = Array.isArray(review?.checks) ? review.checks : [];
  const failed_checks: string[] = [];

  for (const check of checks) {
    if (check?.ok !== false) continue;
    const name = String(check?.name ?? "");
    if (name && !failed_checks.includes(name)) failed_checks.push(name);
  }

  const attempts = Array.isArray(review?.attempts) ? review.attempts : [];
  let last_error: string | null = null;
  for (const attempt of attempts) {
    if (attempt?.error !== undefined && attempt?.error !== null && String(attempt.error).trim()) {
      last_error = truncate(String(attempt.error), maxText);
    }
  }

  const artifactValue = review?.artifacts?.draft;
  const summaryValue = review?.summary;
  let next: string;
  if (status === "ready_for_review") {
    next = "Inspect artifact, apply it locally, run acceptance yourself, then review_pack accept.";
  } else if (status === "needs_brain" || status === "failed") {
    next = "Read last_error and submit a revised work order.";
  } else if (SBCE_ACTIVE_STATES.includes(status)) {
    next = "Still running: call delegate_task status with job_id and wait_s to keep waiting.";
  } else {
    next = "No action needed.";
  }

  const risks = Array.isArray(review?.risks) ? review.risks : [];
  const contextWarning = risks.find((r: unknown) => typeof r === "string" && r.startsWith("Context pack truncated"));

  return {
    job_id: String(job?.id ?? ""),
    status,
    done: !SBCE_ACTIVE_STATES.includes(status),
    attempts: Number(job?.attempts ?? 0) || 0,
    spent_vnd: Number(job?.spentVnd ?? 0) || 0,
    failed_checks,
    last_error,
    artifact: artifactValue == null ? null : String(artifactValue),
    summary: summaryValue == null ? null : truncate(String(summaryValue), maxText),
    next,
    ...(contextWarning ? { context_warning: truncate(contextWarning, maxText) } : {})
  };
}
