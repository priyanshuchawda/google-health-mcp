/** A feature permission was withheld from this OAuth grant. */
export class InsufficientHealthPermissionError extends Error {
  constructor(
    message: string,
    readonly requiredMcpScopes: readonly string[],
  ) {
    super(message);
    this.name = "InsufficientHealthPermissionError";
  }
}
