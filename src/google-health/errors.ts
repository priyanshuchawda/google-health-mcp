export type HealthRequestOutcome = "rejected" | "uncertain";

/** Safe upstream error metadata; upstream response bodies are never retained. */
export class HealthApiError extends Error {
  readonly status: number | undefined;
  readonly methodId: string;
  readonly outcome: HealthRequestOutcome;

  constructor(options: {
    message: string;
    methodId: string;
    status?: number;
    outcome: HealthRequestOutcome;
  }) {
    super(options.message);
    this.name = "HealthApiError";
    this.methodId = options.methodId;
    this.status = options.status;
    this.outcome = options.outcome;
  }
}

export class PaginationLimitError extends Error {
  readonly nextPageToken: string;

  constructor(nextPageToken: string) {
    super(
      "Google Health pagination limit reached; resume using the returned page token.",
    );
    this.name = "PaginationLimitError";
    this.nextPageToken = nextPageToken;
  }
}
