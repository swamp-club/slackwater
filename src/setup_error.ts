/** A problem with how the app is set up. Its message names settings, never their values. */
export class SetupError extends Error {
  override readonly name = "SetupError";
}
