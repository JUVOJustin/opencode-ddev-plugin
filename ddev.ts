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

  /**
   * Raw DDEV project data from `ddev describe -j`
   */
  type DdevRawData = {
    shortroot?: string;
    approot?: string;
    status?: string;
    name?: string;
    [key: string]: unknown;
  };

  /**
   * Cached DDEV state with timestamp for cache invalidation
   */
  type DdevCache = {
    timestamp: number;
    raw: DdevRawData;
  };

  let ddevCache: DdevCache | null = null;
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
   * Gets the project root path from cached DDEV data
   */
  const getProjectRoot = (): string | null => {
    if (!ddevCache?.raw) {
      return null;
    }

    const rawPath = ddevCache.raw.shortroot || ddevCache.raw.approot;
    return rawPath ? expandHomePath(rawPath) : null;
  };

  /**
   * Checks if DDEV is currently running based on cached data
   */
  const isRunning = (): boolean => {
    return ddevCache?.raw?.status === 'running';
  };

  /**
   * Checks if DDEV project is available (installed and configured)
   */
  const isAvailable = (): boolean => {
    return ddevCache !== null;
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
   * Gets the container working directory based on current host directory
   */
  const getContainerWorkingDir = (): string => {
    const projectRoot = getProjectRoot();
    if (!projectRoot) {
      return CONTAINER_ROOT;
    }

    return mapToContainerPath(directory, projectRoot);
  };

  /**
   * Escapes special regex characters in a string
   */
  const escapeRegex = (str: string): string => {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  /**
   * Cleans host paths from the command and removes redundant cd commands.
   * 
   * - Converts host working directory paths to relative paths
   * - Converts other project root paths to container paths
   * - Removes `cd . &&` prefix (no-op after path conversion)
   * 
   * Examples:
   *   mkdir -p /Users/foo/project/wp-content/plugins/sync/src/Class
   *   → mkdir -p src/Class (when --dir is /var/www/html/wp-content/plugins/sync)
   * 
   *   cd /Users/foo/project/wp-content/plugins/sync && composer install
   *   → composer install (cd to current dir is removed)
   * 
   *   cd /Users/foo/project/wp-content/themes && ls
   *   → cd /var/www/html/wp-content/themes && ls (different dir is converted)
   */
  const cleanCommand = (command: string): string => {
    const projectRoot = getProjectRoot();
    if (!projectRoot) {
      return command;
    }

    const containerWorkingDir = getContainerWorkingDir();

    // Calculate the host path that corresponds to the container working directory
    const containerRelative = containerWorkingDir.slice(CONTAINER_ROOT.length).replace(/^\//, '');
    const hostWorkingDir = containerRelative
      ? `${projectRoot}/${containerRelative}`
      : projectRoot;

    let cleanedCommand = command;

    // Replace full host working directory paths with relative paths
    const hostWorkingDirRegex = new RegExp(
      escapeRegex(hostWorkingDir) + '(/[^\\s"\']*|(?=[\\s"\']|$))',
      'g'
    );

    cleanedCommand = cleanedCommand.replace(hostWorkingDirRegex, (match, suffix) => {
      const relativePath = suffix ? suffix.slice(1) : '.';
      return relativePath;
    });

    // Replace any remaining project root paths with container paths (skip if same as hostWorkingDir)
    if (hostWorkingDir !== projectRoot) {
      const projectRootRegex = new RegExp(
        escapeRegex(projectRoot) + '(/[^\\s"\']*|(?=[\\s"\']|$))',
        'g'
      );

      cleanedCommand = cleanedCommand.replace(projectRootRegex, (match, suffix) => {
        if (!suffix) {
          return CONTAINER_ROOT;
        }
        return `${CONTAINER_ROOT}${suffix}`;
      });
    }

    // Remove redundant "cd . &&" prefix (result of cd to current working dir)
    cleanedCommand = cleanedCommand.replace(/^\s*cd\s+(?:\.|(["'])\.?\1)\s*&&\s*/, '');

    return cleanedCommand;
  };

  /**
   * Prompts user to start DDEV when it's stopped
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

    const containerWorkingDir = getContainerWorkingDir();

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
   * Logs a message using OpenCode's app-level logging
   */
  const log = async (level: 'debug' | 'info' | 'warn' | 'error', message: string): Promise<void> => {
    await client.app.log({
      body: {
        service: 'ddev-plugin',
        level,
        message,
      },
    });
  };

  /**
   * Fetches and caches DDEV project data.
   * Uses caching to avoid repeated checks (cache expires after 2 minutes).
   * Only caches when DDEV is running; stopped/unavailable states are not cached.
   */
  async function refreshDdevCache(): Promise<void> {
    const now = Date.now();

    // Return if cache is still valid
    if (ddevCache && now - ddevCache.timestamp < CACHE_DURATION_MS) {
      return;
    }

    try {
      const result = await $`ddev describe -j`.quiet().nothrow();

      // DDEV not available (not installed or no project)
      if (result.exitCode !== 0) {
        ddevCache = null;
        return;
      }

      const output = result.stdout.toString();

      let data;
      try {
        data = JSON.parse(output);
      } catch (parseError) {
        await log('error', `Failed to parse DDEV JSON output: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        ddevCache = null;
        return;
      }

      const raw = data?.raw as DdevRawData | undefined;

      if (!raw) {
        ddevCache = null;
        return;
      }

      // Only cache when running; stopped state should be re-checked
      if (raw.status !== 'running') {
        // Do not cache stopped state; force re-check next time
        ddevCache = { timestamp: 0, raw };
        return;
      }

      ddevCache = { timestamp: now, raw };
    } catch (error) {
      await log('error', `DDEV status check failed: ${error instanceof Error ? error.message : String(error)}`);
      ddevCache = null;
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
   * Wraps command with ddev exec for container execution.
   * Cleans host paths and removes redundant cd commands.
   */
  const wrapWithDdevExec = (command: string): string => {
    const cleanedCommand = cleanCommand(command);
    const containerWorkingDir = getContainerWorkingDir();
    const escapedCommand = JSON.stringify(cleanedCommand);

    return `ddev exec --dir=${JSON.stringify(containerWorkingDir)} bash -c ${escapedCommand}`;
  };

  // Initialize DDEV detection
  await refreshDdevCache();

  // Capture availability at initialization for tool registration
  const hasProject = isAvailable();

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

      // Refresh DDEV cache (with caching)
      await refreshDdevCache();

      // DDEV not available - exit early
      if (!isAvailable()) {
        return;
      }

      // DDEV available but stopped - ask user to start it
      if (!isRunning() && !hasAskedToStart) {
        await askToStartDdev();
        return;
      }

      // DDEV not running - don't wrap commands
      if (!isRunning()) {
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
        await log('debug', `Wrapped command: ${originalCommand.substring(0, 80)}${originalCommand.length > 80 ? '...' : ''}`);
      }
    },

    // Register custom tools only if DDEV project exists (running or stopped)
    ...(hasProject ? {
      tool: {
        ddev_logs: createDdevLogsTool($),
      },
    } : {}),
  };
};
