export class JixuError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JixuError";
    this.code = code;
  }
}

export class RunAlreadyExistsError extends JixuError {
  constructor(runId: string) {
    super("run_already_exists", `Run ${runId} already exists`);
    this.name = "RunAlreadyExistsError";
  }
}

export class RunNotFoundError extends JixuError {
  constructor(runId: string) {
    super("run_not_found", `Run ${runId} does not exist`);
    this.name = "RunNotFoundError";
  }
}

export class RevisionConflictError extends JixuError {
  readonly actualRevision: number;
  readonly expectedRevision: number;
  readonly runId: string;

  constructor(runId: string, expectedRevision: number, actualRevision: number) {
    super(
      "revision_conflict",
      `Run ${runId} expected revision ${expectedRevision}, received ${actualRevision}`,
    );
    this.name = "RevisionConflictError";
    this.actualRevision = actualRevision;
    this.expectedRevision = expectedRevision;
    this.runId = runId;
  }
}

export class InvalidTransitionError extends JixuError {
  constructor(message: string) {
    super("invalid_transition", message);
    this.name = "InvalidTransitionError";
  }
}

export class UnsupportedEventError extends JixuError {
  constructor(message: string) {
    super("unsupported_event", message);
    this.name = "UnsupportedEventError";
  }
}

export class SchemaValidationError extends JixuError {
  constructor(message: string) {
    super("schema_validation", message);
    this.name = "SchemaValidationError";
  }
}

export class AgentMismatchError extends JixuError {
  constructor(runId: string) {
    super(
      "agent_mismatch",
      `Agent definition does not match the durable snapshot for Run ${runId}`,
    );
    this.name = "AgentMismatchError";
  }
}

export class InvalidForkPointError extends JixuError {
  constructor(runId: string, eventId: string) {
    super(
      "invalid_fork_point",
      `Event ${eventId} is not a valid fork point in Run ${runId}`,
    );
    this.name = "InvalidForkPointError";
  }
}
