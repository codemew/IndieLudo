/** An expected failure with a stable code the client can show or branch on. */
export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
