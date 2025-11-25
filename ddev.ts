import type { Plugin } from "@opencode-ai/plugin";
import { createDdevLogsTool } from "./logs";

/**
 * DDEV Plugin for OpenCode
 * 
 * Automatically detects DDEV availability and wraps bash commands
 * to execute inside the DDEV container.
 */
export const DDEVPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  const CONTAINER_ROOT = '/var/www/html' as const;
  const HOST_ONLY_COMMANDS = ['git', 'gh', 'docker', 'ddev'] as const;
  const CACHE_DURATION_MS = 120000; // 2 minutes

  type DdevStatus = {
    available: boolean;    // Is DDEV installed and configured for this project?
    running: boolean;      // Is DDEV currently running?
  };

  let lastCheck: { timestamp: number; status: DdevStatus } | null = null;
  let containerWorkingDir: string = CONTAINER_ROOT;
  let currentSessionId: string | null = null;
  let hasNotifiedSession = false;
  let hasAskedToStart = false;

  /**
   * Expands tilde (~) in path to full home directory
   */
  const expandHomePath = (path: string): string => {
    if (!path.startsWith('~')) {
      return path;
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE;
    return path.replace('~', homeDir || '');
  };

  /**
   * Extracts DDEV project path and status from JSON describe output
   */
  const extractProjectInfo = (jsonOutput: string): { path: string | null; status: string | null } => {
    try {
      const data = JSON.parse(jsonOutput);

      // The project path is in the "raw.shortroot" or "raw.approot" field
      const projectPath = data?.raw?.shortroot || data?.raw?.approot;
      const status = data?.raw?.status;

      return {
        path: projectPath ? expandHomePath(projectPath) : null,
        status: status || null,
      };
    } catch (error) {
      console.error(`Failed to parse DDEV JSON output: ${error instanceof Error ? error.message : String(error)}`);
      return { path: null, status: null };
    }
  };

  /**
   * Maps host directory to container directory path
   */
  const mapToContainerPath = (hostDir: string, projectRoot: string): string => {
    if (!hostDir.startsWith(projectRoot)) {
      return CONTAINER_ROOT;
    }

    const relativePath = hostDir
      .slice(projectRoot.length)
      .replace(/^\//, '');

    if (!relativePath) {
      return CONTAINER_ROOT;
    }

    return `${CONTAINER_ROOT}/${relativePath}`;
  };

  /**
   * Add to context that ddev can be started
   */
  const askToStartDdev = async (): Promise<void> => {
    if (hasAskedToStart || !currentSessionId) {
      return;
    }

    await client.session.prompt({
      path: { id: currentSessionId },
      body: {
        parts: [
          {
            type: 'text',
            text: '⚠️  DDEV environment is stopped. Start it using `ddev start`?',
          },
        ],
        noReply: true,
      },
    });
    hasAskedToStart = true;
  };

  /**
   * Notifies LLM about DDEV environment on first command execution
   */
  const notifyDdevInSession = async (): Promise<void> => {
    if (hasNotifiedSession || !currentSessionId) {
      return;
    }

    await client.session.prompt({
      path: { id: currentSessionId },
      body: {
        parts: [
          {
            type: 'text',
            text: `➡️  DDEV environment is used. Execute commands inside the DDEV container like this: \`ddev exec --dir="${containerWorkingDir}" bash -c <command>\``,
          },
        ],
        noReply: true,
      },
    });
    hasNotifiedSession = true;
  };

  /**
   * Checks DDEV availability and status
   * Uses caching to avoid repeated checks (cache expires after 1 minute)
   * 
   * Returns:
   * - available: true if DDEV is installed and configured for this project
   * - running: true if DDEV containers are currently running
   * 
   * Side effects when running:
   * - Sets containerWorkingDir based on project path
   */
  async function checkDdevStatus(): Promise<DdevStatus> {
    // Return cached status if still valid
    const now = Date.now();
    if (lastCheck && now - lastCheck.timestamp < CACHE_DURATION_MS) {
      return lastCheck.status;
    }

    // Perform the check
    try {
      const result = await $`ddev describe -j`.quiet().nothrow();

      // DDEV not available (not installed or no project)
      if (result.exitCode !== 0) {
        const status: DdevStatus = { available: false, running: false };
        lastCheck = null; // Don't cache failures
        return status;
      }

      const output = result.stdout.toString();
      const { path: projectRoot, status: projectStatus } = extractProjectInfo(output);

      // DDEV is available but stopped
      if (projectStatus === 'stopped') {
        const status: DdevStatus = { available: true, running: false };
        lastCheck = null; // Don't cache stopped state
        return status;
      }

      // DDEV is available and running - configure paths
      if (projectRoot) {
        containerWorkingDir = mapToContainerPath(directory, projectRoot);
      } else {
        containerWorkingDir = CONTAINER_ROOT;
      }

      const status: DdevStatus = { available: true, running: true };
      lastCheck = { timestamp: now, status };
      return status;
    } catch (error) {
      console.error(`DDEV status check failed: ${error instanceof Error ? error.message : String(error)}`);
      const status: DdevStatus = { available: false, running: false };
      lastCheck = null;
      return status;
    }
  }

  /**
   * Determines if command should run on host instead of container
   */
  const shouldRunOnHost = (command: string): boolean => {
    if (command.startsWith('ddev ')) {
      return true;
    }

    const firstWord = command.trim().split(/\s+/)[0];
    return HOST_ONLY_COMMANDS.includes(firstWord as typeof HOST_ONLY_COMMANDS[number]);
  };

  /**
   * Removes redundant cd command if it matches current directory
   */
  const removeRedundantCd = (command: string): string => {
    // Regex to match: cd <path> && (rest of command)
    // Handles optional whitespace and quotes around path
    const cdRegex = /^\s*cd\s+(['"]?)([^\s&;|'"]+)\1\s*&&\s*/;
    const match = command.match(cdRegex);

    if (!match) {
      return command;
    }

    const cdPath = match[2];

    // Check if cd path matches current directory
    if (cdPath === directory) {
      const cleanedCommand = command.replace(cdRegex, '');
      return cleanedCommand;
    }

    return command;
  };

  /**
   * Wraps command with ddev exec for container execution
   */
  const wrapWithDdevExec = (command: string): string => {
    const cleanedCommand = removeRedundantCd(command);
    const escapedCommand = JSON.stringify(cleanedCommand);
    return `ddev exec --dir="${containerWorkingDir}" bash -c ${escapedCommand}`;
  };

  // Initialize DDEV detection (initial check)
  const initialStatus = await checkDdevStatus();

  return {
    event: async ({ event }) => {
      if (event.type === 'session.created') {
        currentSessionId = event.properties.info.id;
        hasNotifiedSession = false;
        hasAskedToStart = false;
      }
    },

    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'bash') {
        return;
      }

      const originalCommand = output.args.command as string;

      if (shouldRunOnHost(originalCommand)) {
        return;
      }

      // Check DDEV status (with caching)
      const status = await checkDdevStatus();

      // DDEV not available at all - exit early
      if (!status.available) {
        return;
      }

      // DDEV available but stopped - ask user to start it
      if (!status.running && !hasAskedToStart) {
        await askToStartDdev();
        return;
      }

      // DDEV not running - don't wrap commands
      if (!status.running) {
        return;
      }

      // DDEV is running - notify and wrap command
      if (!hasNotifiedSession) {
        await notifyDdevInSession();
      }

      const wrappedCommand = wrapWithDdevExec(originalCommand);
      output.args.command = wrappedCommand;

      // Log if command was modified
      if (originalCommand !== wrappedCommand && !originalCommand.startsWith('ddev exec')) {
        await client.app.log({
          body: {
            service: 'ddev-plugin',
            level: 'debug',
            message: `Wrapped command (cd removed if redundant): ${originalCommand.substring(0, 80)}${originalCommand.length > 80 ? '...' : ''}`,
          },
        });
      }
    },

    // Register custom tools only if DDEV project exists (running or stopped)
    ...(initialStatus.available ? {
      tool: {
        ddev_logs: createDdevLogsTool($),
      },
    } : {}),
  };
};
