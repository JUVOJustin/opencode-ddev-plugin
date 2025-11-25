import { tool } from "@opencode-ai/plugin";

/**
 * Creates a DDEV logs tool for viewing container logs
 * 
 * Provides access to `ddev logs` command functionality, allowing retrieval
 * of logs from different services (web, db, etc.) with various options.
 */
export const createDdevLogsTool = ($: any) => {
  // Conservative default to reduce context pollution
  const DEFAULT_TAIL_LINES = 50;

  return tool({
    description: "Get logs from DDEV services (web, db, etc.). Use this to debug issues or monitor service output. It will give great insight on user questions like 'is my request reaching the application?' or 'why is my database connection failing?'.",
    args: {
      service: tool.schema.string().optional().describe("Service to get logs from (e.g., 'web', 'db'). Defaults to 'web' if not specified."),
      follow: tool.schema.boolean().optional().describe("Follow logs in real-time (stream logs as they appear). Cannot be used with tail option."),
      tail: tool.schema.number().optional().describe(`Number of lines to show from the end of logs. Defaults to ${DEFAULT_TAIL_LINES} if not specified. Mutually exclusive with follow.`),
      time: tool.schema.boolean().optional().describe("Add timestamps to log output."),
    },
    async execute(args) {
      try {
        // Build command parts
        let baseCmd = "ddev logs";

        // Add service flag if specified
        if (args.service) {
          baseCmd += ` -s ${args.service}`;
        }

        // Add follow flag if specified
        if (args.follow) {
          baseCmd += " -f";
        } else {
          // Apply default tail if not following and tail not explicitly set
          const tailLines = args.tail ?? DEFAULT_TAIL_LINES;
          baseCmd += ` --tail ${tailLines}`;
        }

        // Add time flag if specified
        if (args.time) {
          baseCmd += " -t";
        }

        // Execute the command
        const result = await $`sh -c ${baseCmd}`.quiet().nothrow();

        if (result.exitCode !== 0) {
          const stderr = result.stderr.toString().trim();
          const stdout = result.stdout.toString().trim();
          const errorMsg = stderr || stdout || 'Command failed with no output';
          throw new Error(`DDEV logs command failed (exit code ${result.exitCode}): ${errorMsg}`);
        }

        return result.stdout.toString();
      } catch (error) {
        throw new Error(`Failed to get DDEV logs: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
};
