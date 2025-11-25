# opencode-ddev-plugin

DDEV Plugin for OpenCode - Automatically detects DDEV availability and wraps bash commands to execute inside the DDEV container.

## Features

- **Automatic DDEV Detection**: Checks if DDEV is available using `ddev describe -j` for structured JSON output
- **Container Command Wrapping**: Automatically wraps bash commands with `ddev exec` for container execution
- **Host-Only Commands**: Preserves commands that should run on the host (git, gh, docker, ddev)
- **Path Mapping**: Maps host directories to container paths correctly using JSON-based project detection
- **Session Notifications**: Notifies the LLM about DDEV environment once per session

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

1. Automatically detect DDEV availability when a session starts
2. Wrap bash commands to execute inside the DDEV container
3. Preserve host-only commands (git, gh, docker, ddev) to run on the host
4. Map working directories correctly between host and container

Example commands that will be automatically wrapped:
- `ls -la` → `ddev exec --dir="/var/www/html" bash -c "ls -la"`
- `npm install` → `ddev exec --dir="/var/www/html" bash -c "npm install"`

Commands that run on host (not wrapped):
- `git status`
- `gh pr create`
- `docker ps`
- `ddev describe`