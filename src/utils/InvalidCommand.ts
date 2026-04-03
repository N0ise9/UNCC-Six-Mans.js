export class InvalidCommand extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Invalid command";
  }
}

export function isRecordNotFoundError(err: unknown): err is RecordNotFound {
  return err instanceof RecordNotFound || (err instanceof Error && "code" in err && err.code === "P2025");
}

export class RecordNotFound extends Error {
  readonly code = "P2025";

  constructor(message: string) {
    super(message);
    this.name = "Record not found";
  }
}
