/**
 * Runs once when the server starts. What needs Node (`process.exit`) is in its own file, loaded only
 * under the Node.js runtime: this file is also compiled for the Edge runtime, which has no such API.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkStartup } = await import("./instrumentation-node");
  checkStartup(process.env);
}
