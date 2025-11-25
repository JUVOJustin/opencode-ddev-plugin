# opencode-ddev-plugin

DDEV Plugin for [OpenCode](https://opencode.ai) - Automatically detects DDEV availability and wraps bash commands to execute inside the DDEV container.

## Features

- **Automatic DDEV Detection**: Checks if DDEV is available using `ddev describe -j` for structured JSON output
- **Stopped Container Detection**: Detects when DDEV is available but stopped, and prompts to start it
- **Container Command Wrapping**: Automatically wraps bash commands with `ddev exec` for container execution
- **Host-Only Commands**: Preserves commands that should run on the host (git, gh, docker, ddev)
- **Path Mapping**: Maps host directories to container paths correctly using JSON-based project detection
- **Session Notifications**: Notifies the LLM about DDEV environment only on first bash command execution (to save tokens)
- **Custom DDEV Logs Tool**: Provides a `ddev_logs` tool for retrieving logs from DDEV services

## How to Include as Submodule

Add this plugin to your OpenCode configuration as a Git submodule:

```bash
# Add the submodule
git submodule add git@github.com:JUVOJustin/opencode-ddev-plugin.git plugin/ddev

# Create an index.js file in the plugin root directory
echo 'export { DDEVPlugin } from "./ddev/ddev.js";' > plugin/index.js

# Commit the changes
git add .gitmodules plugin/ddev plugin/index.js
git commit -m "Add DDEV plugin as submodule"
```

## Loading the Plugin

To load plugins from the plugin subfolder, ensure your OpenCode configuration includes the plugin directory. The plugin will be automatically discovered and loaded.

## Usage

Once installed, the plugin will:

1. Automatically detect DDEV availability and status when a session starts
2. Adds context to start DDEV if it's detected but stopped
3. Wrap bash commands to execute inside the DDEV container (when running)
4. Preserve host-only commands (git, gh, docker, ddev) to run on the host
5. Map working directories correctly between host and container

Example commands that will be automatically wrapped:
- `ls -la` → `ddev exec --dir="/var/www/html" bash -c "ls -la"`
- `npm install` → `ddev exec --dir="/var/www/html" bash -c "npm install"`

Bash tool commands that run on host (not wrapped):
- `git`
- `gh`
- `docker`
- `ddev`

## Custom Tools

The plugin provides custom tools that are registered when a DDEV project is detected:

### `ddev_logs` Tool

Retrieve logs from DDEV services for debugging and monitoring.

**Arguments:**
- `service` (optional): Service to get logs from (e.g., 'web', 'db'). Defaults to 'web'.
- `follow` (optional): Follow logs in real-time (stream as they appear). Cannot be used with `tail`.
- `tail` (optional): Number of lines to show from the end of logs. Defaults to 50 lines if not specified. Mutually exclusive with `follow`.
- `time` (optional): Add timestamps to log output.

**Default Behavior:**
- When neither `follow` nor `tail` is specified, returns the last 50 lines to prevent context pollution.
- The 50-line default is conservative to keep responses concise while providing sufficient debugging context.

**Examples:**
```javascript
// Get last 50 lines from web service (default)
ddev_logs()

// Get last 100 lines from database service
ddev_logs({ service: "db", tail: 100 })

// Follow web service logs in real-time with timestamps
ddev_logs({ follow: true, time: true })
```
