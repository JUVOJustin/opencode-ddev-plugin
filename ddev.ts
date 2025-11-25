import type { Plugin } from "@opencode-ai/plugin";

/**
 * DDEV Plugin for OpenCode
 * 
 * Automatically detects DDEV availability and wraps bash commands
 * to execute inside the DDEV container.
 */
export const DDEVPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  const CONTAINER_ROOT = '/var/www/html' as const;
  const HOST_ONLY_COMMANDS = ['git', 'gh', 'docker', 'ddev'] as const;

  let isDdevAvailable = false;
  let containerWorkingDir: string = CONTAINER_ROOT;
  let currentSessionId: string | null = null;
  let hasNotifiedSession = false;

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
   * Extracts DDEV project path from JSON describe output
   */
  const extractProjectPath = (jsonOutput: string): string | null => {
    try {
      const data = JSON.parse(jsonOutput);
      
      // The project path is in the "raw.shortroot" or "raw.approot" field
      const projectPath = data?.raw?.shortroot || data?.raw?.approot;
      
      if (!projectPath) {
        return null;
      }

      return expandHomePath(projectPath);
    } catch (error) {
      console.error(`Failed to parse DDEV JSON output: ${error instanceof Error ? error.message : String(error)}`);
      return null;
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
   * Notifies LLM about DDEV environment once per session
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
   * Checks if DDEV is available and configures path mapping
   */
  const checkDdevAvailability = async (): Promise<void> => {
    try {
      const result = await $`ddev describe -j`.quiet().nothrow();

      if (result.exitCode !== 0) {
        isDdevAvailable = false;
        return;
      }

      isDdevAvailable = true;
      const output = result.stdout.toString();
      const projectRoot = extractProjectPath(output);

      if (!projectRoot) {
        containerWorkingDir = CONTAINER_ROOT;
        return;
      }

      containerWorkingDir = mapToContainerPath(directory, projectRoot);
    } catch (error) {
      isDdevAvailable = false;
      console.error(`DDEV availability check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

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

  // Initialize DDEV detection
  await checkDdevAvailability();

  return {
    event: async ({ event }) => {
      if (event.type === 'session.created') {

        currentSessionId = event.properties.info.id;
        hasNotifiedSession = false;

        if (isDdevAvailable) {
          // Notify LLM about DDEV environment
          await notifyDdevInSession();
        }
      }
    },

    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'bash') {
        return;
      }

      if (!isDdevAvailable) {
        return;
      }

      const originalCommand = output.args.command as string;

      if (shouldRunOnHost(originalCommand)) {
        return;
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
  };
};
