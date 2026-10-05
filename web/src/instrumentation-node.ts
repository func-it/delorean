import { refuseToStart } from "@/lib/startup";

/**
 * A setting the app refuses to run with stops it here, with a clear line and a non-zero exit (a throw
 * would leave the server running).
 */
export function checkStartup(env: NodeJS.ProcessEnv) {
  refuseToStart(env, (message) => {
    console.error(message);
    process.exit(1);
  });
}
