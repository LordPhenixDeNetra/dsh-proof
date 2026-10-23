# Security policy

## Supported versions

The latest published minor version receives fixes. The plugin is pre-1.0 and targets DSH `>=0.2.1-rc.2 <0.3.0`.

## Threat model

`dsh-proof` executes **operator-configured shell commands** with the privileges of the user running DSH. Those commands run outside the DSH file sandbox, exactly like a script typed in a terminal or an `npm test` invocation.

- Only configure checks you trust.
- A check command may read environment variables, including credentials available to the DSH process.
- Check output is sent to the model and stored in the session log. Do not print secrets from a check.
- The plugin itself does not modify files, but configured checks (formatters, snapshot updates) may do so.
- The model cannot inject arguments into check commands: commands come from configuration or from `package.json` scripts.

## Reporting a vulnerability

Open a private security advisory on the repository hosting this package. Include the plugin version, DSH version, operating system, the configuration used, and a minimal reproduction. Do not include real credentials.

## Scope

In scope: command injection through plugin inputs, path traversal, unintended command execution, leaks of configuration or credentials, denial of service through unbounded output or processes.

Out of scope: vulnerabilities in commands the operator configured, in DSH itself, or in third-party packages installed by those commands.
