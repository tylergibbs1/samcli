/**
 * Machine-readable error envelope for agent consumption.
 *
 * Every error path in the CLI ends here. Agents parse the JSON envelope on
 * stderr, get a stable `code`, and can react programmatically.
 */

export type ErrorCode =
  | "MISSING_API_KEY"
  | "INVALID_INPUT"
  | "INVALID_DATE_RANGE"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR"
  | "INTERNAL_ERROR";

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly suggestion?: string;
  readonly exitCode: number;

  constructor(opts: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    suggestion?: string;
    exitCode?: number;
  }) {
    super(opts.message);
    this.name = "CliError";
    this.code = opts.code;
    this.details = opts.details;
    this.suggestion = opts.suggestion;
    this.exitCode = opts.exitCode ?? 1;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: true,
      code: this.code,
      message: this.message,
      ...(this.suggestion !== undefined && { suggestion: this.suggestion }),
      ...(this.details !== undefined && { details: this.details }),
    };
  }
}

export function reportError(err: unknown): never {
  const cliErr = err instanceof CliError
    ? err
    : new CliError({
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });

  process.stderr.write(JSON.stringify(cliErr.toJSON()) + "\n");
  process.exit(cliErr.exitCode);
}
