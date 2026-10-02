import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A self-contained server for the Docker image (see Dockerfile).
  output: "standalone",
  // `next dev` would otherwise write AGENTS.md and CLAUDE.md into web/.
  agentRules: false,
};

export default nextConfig;
