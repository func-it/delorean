import { refuseToStart } from "@/lib/startup";

/**
 * Runs once when the server starts: a setting the app refuses to run with
 * stops it here, with a clear line and a non-zero exit (a throw would leave
 * the server running).
 */
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  refuseToStart(process.env, (message) => {
    console.error(message);
    process.exit(1);
  });
}
