export class JixuError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JixuError";
    this.code = code;
  }
}

export class ToolExecutionError extends JixuError {
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(code, message);
    this.name = "ToolExecutionError";
    this.retryable = retryable;
  }
}

export class ThreadAlreadyExistsError extends JixuError {
  constructor(threadId: string) {
    super("thread_already_exists", `Thread ${threadId} already exists`);
    this.name = "ThreadAlreadyExistsError";
  }
}

export class ThreadNotFoundError extends JixuError {
  constructor(threadId: string) {
    super("thread_not_found", `Thread ${threadId} does not exist`);
    this.name = "ThreadNotFoundError";
  }
}

export class RevisionConflictError extends JixuError {
  readonly actualRevision: number;
  readonly expectedRevision: number;
  readonly threadId: string;

  constructor(threadId: string, expectedRevision: number, actualRevision: number) {
    super(
      "revision_conflict",
      `Thread ${threadId} expected revision ${expectedRevision}, received ${actualRevision}`,
    );
    this.name = "RevisionConflictError";
    this.actualRevision = actualRevision;
    this.expectedRevision = expectedRevision;
    this.threadId = threadId;
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
  constructor(threadId: string) {
    super(
      "agent_mismatch",
      `Agent definition does not match the durable snapshot for Thread ${threadId}`,
    );
    this.name = "AgentMismatchError";
  }
}

export class InvalidForkPointError extends JixuError {
  constructor(threadId: string, eventId: string) {
    super(
      "invalid_fork_point",
      `Event ${eventId} is not a valid fork point in Thread ${threadId}`,
    );
    this.name = "InvalidForkPointError";
  }
}
