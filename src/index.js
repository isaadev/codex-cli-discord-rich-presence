#!/usr/bin/env node

import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import RPC from "discord-rpc";

const clientId = process.env.DISCORD_CLIENT_ID;

if (!clientId) {
  console.error("Missing DISCORD_CLIENT_ID. See README.md for setup instructions.");
  process.exit(1);
}

const presenceOnly = process.argv.includes("--presence-only");
const codexArgs = process.argv.slice(2).filter((arg) => arg !== "--presence-only");
const startedAt = new Date();
let rpc;
let shuttingDown = false;
let presenceTimer;
let reconnectTimer;
let connecting = false;
let lastActivityText;

function formatTokens(tokens) {
  if (!Number.isFinite(tokens)) return "Token usage: waiting…";
  if (tokens >= 1_000_000) return `Tokens: ${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `Tokens: ${(tokens / 1_000).toFixed(1)}K`;
  return `Tokens: ${tokens}`;
}

async function latestSessionFile() {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");

  try {
    const entries = await fs.readdir(sessionsDir, {
      recursive: true,
      withFileTypes: true
    });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(entry.parentPath, entry.name));
    const candidates = await Promise.all(
      files.map(async (file) => ({ file, stat: await fs.stat(file) }))
    );

    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    for (const candidate of candidates) {
      try {
        const handle = await fs.open(candidate.file, "r");
        const buffer = Buffer.alloc(Math.min(candidate.stat.size, 64 * 1024));
        await handle.read(buffer, 0, buffer.length, 0);
        await handle.close();
        const firstLine = buffer.toString("utf8").split("\n", 1)[0];
        const metadata = JSON.parse(firstLine);

        if (metadata.payload?.source === "cli") return candidate.file;
      } catch {
        // Ignore incomplete or non-session files and continue searching.
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function commandOutput(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
}

async function hasRunningCodex() {
  if (process.platform === "win32") {
    const output = await commandOutput("tasklist.exe", [
      "/fi",
      "imagename eq codex.exe",
      "/fo",
      "csv",
      "/nh"
    ]);
    return /^"codex\.exe"/im.test(output);
  }

  const output = await commandOutput("ps", ["-A", "-o", "comm="]);
  return output.split("\n").some((name) => /(^|\/)codex$/.test(name.trim()));
}

async function readSessionActivity() {
  const file = await latestSessionFile();
  if (!file) return {};

  try {
    const handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const bytesToRead = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, size - bytesToRead);

    const headerBuffer = Buffer.alloc(Math.min(size, 64 * 1024));
    await handle.read(headerBuffer, 0, headerBuffer.length, 0);
    await handle.close();

    let workingDirectory = process.cwd();
    try {
      const firstLine = headerBuffer.toString("utf8").split("\n", 1)[0];
      workingDirectory = JSON.parse(firstLine).payload?.cwd || workingDirectory;
    } catch {
      // Fall back to the directory where the presence process was started.
    }

    const lines = buffer.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"token_count"')) continue;
      try {
        const event = JSON.parse(line);
        return {
          workingDirectory,
          tokens: event.payload?.info?.total_token_usage?.total_tokens
        };
      } catch {
        // The first line may be partial when reading only the tail of the file.
      }
    }
    return { workingDirectory };
  } catch {
    return {};
  }
}

async function updatePresence() {
  if (!(await hasRunningCodex())) {
    if (lastActivityText !== "inactive") {
      await rpc?.clearActivity();
      console.log("Presence cleared: no Codex CLI process is running.");
      lastActivityText = "inactive";
    }
    return;
  }

  const session = await readSessionActivity();
  const workingDirectory = session.workingDirectory || process.cwd();
  const activityText = `${workingDirectory}|${session.tokens ?? "waiting"}`;

  if (!rpc) throw new Error("Discord RPC is not connected");

  await rpc.setActivity({
    details: `Working in ${path.basename(workingDirectory)}`,
    state: formatTokens(session.tokens),
    startTimestamp: startedAt,
    largeImageKey: process.env.DISCORD_LARGE_IMAGE_KEY || "codex-cli-dark",
    largeImageText: workingDirectory,
    instance: false
  });

  if (activityText !== lastActivityText) {
    console.log(`Presence updated: Working in ${path.basename(workingDirectory)} | ${formatTokens(session.tokens)}`);
    lastActivityText = activityText;
  }
}

function codexProcess() {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "codex.cmd", ...codexArgs]
    };
  }

  return { command: "codex", args: codexArgs };
}

async function connectPresence() {
  if (shuttingDown || connecting) return;
  connecting = true;
  const client = new RPC.Client({ transport: "ipc" });
  rpc = client;

  client.once("ready", async () => {
    connecting = false;
    clearInterval(presenceTimer);

    try {
      await updatePresence();
      console.log("Discord Rich Presence connected.");
    } catch (error) {
      console.warn(`Initial presence update failed: ${error.message}`);
      scheduleReconnect();
      return;
    }

    presenceTimer = setInterval(() => {
      void updatePresence().catch((error) => {
        console.warn(`Presence update failed: ${error.message}`);
        scheduleReconnect();
      });
    }, 15_000);
  });

  client.once("disconnected", () => {
    connecting = false;
    console.warn("Discord disconnected; reconnecting…");
    scheduleReconnect();
  });

  client.on("error", (error) => {
    console.warn(`Discord RPC error: ${error.message}`);
  });

  try {
    await client.login({ clientId });
  } catch (error) {
    connecting = false;
    console.warn(`Discord Rich Presence unavailable: ${error.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  clearInterval(presenceTimer);
  presenceTimer = undefined;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connectPresence();
  }, 5_000);

  try {
    rpc?.destroy();
  } catch {
    // The IPC connection may already be gone.
  }
  rpc = undefined;
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(presenceTimer);
  clearTimeout(reconnectTimer);

  try {
    await rpc?.clearActivity();
    rpc?.destroy();
  } catch {
    // Discord may already be closed; there is nothing left to clean up.
  }

  process.exit(exitCode);
}

void connectPresence();

if (presenceOnly) {
  console.log("Running in presence-only mode.");
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
} else {
  const codexCommand = codexProcess();
  const codex = spawn(codexCommand.command, codexCommand.args, {
    stdio: "inherit",
    shell: false,
    env: process.env
  });

  codex.on("error", (error) => {
    console.error(`Could not start Codex CLI: ${error.message}`);
    void shutdown(1);
  });

  codex.on("exit", (code, signal) => {
    if (signal) {
      console.warn(`Codex exited after receiving ${signal}.`);
    }
    void shutdown(code ?? 0);
  });

  process.on("SIGINT", () => codex.kill("SIGINT"));
  process.on("SIGTERM", () => codex.kill("SIGTERM"));
}
