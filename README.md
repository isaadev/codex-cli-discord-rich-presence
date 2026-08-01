# Codex CLI Discord Rich Presence

A tiny wrapper that launches Codex CLI and shows the session in Discord with a dark command-line icon.

## Requirements

- Node.js 20.12 or newer
- Codex CLI available as `codex`
- The Discord desktop app running

## Discord setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications) and name it `Codex CLI`.
2. Open **Rich Presence → Art Assets** and upload `assets/codex-cli-dark.png`.
3. Set the asset name/key to exactly `codex-cli-dark`.
4. Copy the application's **Application ID** from **General Information**.

Discord can take a few minutes to make a newly uploaded asset available.

## Install

```powershell
npm install
npm link
Copy-Item .env.example .env
# Edit .env and replace your_discord_application_id
codex-rp
```

Any arguments are passed through to Codex:

```powershell
codex-rp --help
codex-rp resume --last
```

To keep Rich Presence running independently and follow the newest Codex session:

```powershell
codex-rp --presence-only
```

In presence-only mode, leave that process running while you use Codex from other terminals or integrations. The activity follows the most recently updated local Codex session.

Alternatively, set the application ID for your Windows user:

```powershell
[Environment]::SetEnvironmentVariable("DISCORD_CLIENT_ID", "YOUR_APPLICATION_ID", "User")
```

Restart the terminal after setting it permanently.

## Optional asset key

```powershell
$env:DISCORD_LARGE_IMAGE_KEY = "codex-cli-dark"
```

The presence shows the current working directory and refreshes total Codex token usage every 15 seconds. It automatically clears when the Codex process exits. If Discord is closed or unavailable, Codex still launches normally.

## Icon

`assets/codex-cli-dark.png` is an original, dark-mode terminal-inspired icon created for this project. It is not an official OpenAI or Codex logo.
