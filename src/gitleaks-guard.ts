import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installGitleaksBinary } from "./install.js";

type GitleaksFinding = {
  RuleID?: string;
  Description?: string;
  StartLine?: number;
  StartColumn?: number;
};

const TEMP_DIRECTORY_PREFIX = "prompt-doctor-gitleaks-";
const TEMP_INPUT_FILE = "content.txt";
const TEMP_REPORT_FILE = "report.json";
const MAX_EXPOSED_MESSAGES = 5;

export class SecretLeakageDetectedError extends Error {
  constructor(messages: string[]) {
    super(
      `gitleaks detected sensitive content:\n${messages
        .slice(0, MAX_EXPOSED_MESSAGES)
        .map((entry, index) => `${index + 1}. ${entry}`)
        .join("\n")}`
    );
    this.name = "SecretLeakageDetectedError";
  }
}

export class GitleaksGuard {
  private gitleaksBin: string;

  constructor() {
    this.gitleaksBin = this.resolveGitleaksBin();
  }

  public async assertNoSecrets(label: string, content: string | undefined): Promise<void> {
    if (!content?.trim()) {
      return;
    }

    const findings = await this.scanWithGitleaks(content);
    if (findings.length === 0) {
      return;
    }

    const formatted = findings.map((message) => `${label}: ${message}`);
    throw new SecretLeakageDetectedError(formatted);
  }

  private resolveGitleaksBin(): string {
    if (process.env.GITLEAKS_BIN?.trim()) {
      return process.env.GITLEAKS_BIN;
    }

    const localBin = path.join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "gitleaks.cmd" : "gitleaks"
    );

    const candidates =
      process.platform === "win32"
        ? [localBin, "gitleaks.exe", "gitleaks"]
        : [localBin, "/opt/homebrew/bin/gitleaks", "/usr/local/bin/gitleaks", "gitleaks"];

    const existingCandidate = candidates.find((candidate) => candidate.includes("/") && existsSync(candidate));
    return existingCandidate ?? "gitleaks";
  }

  private async scanWithGitleaks(content: string): Promise<string[]> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), TEMP_DIRECTORY_PREFIX));
    const inputPath = path.join(tempDir, TEMP_INPUT_FILE);
    const reportPath = path.join(tempDir, TEMP_REPORT_FILE);

    try {
      await writeFile(inputPath, content, "utf8");

      const args = this.buildGitleaksArgs(tempDir, reportPath);
      const { stdout, stderr, exitCode } = await this.runCommandWithAutoInstall(args);

      const report = await this.readReport(reportPath);
      const messages = this.parseReport(report);
      if (messages.length > 0) {
        return messages;
      }

      if (exitCode !== 0) {
        throw new Error(stderr || `gitleaks exited with code ${exitCode}`);
      }

      return [];
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private buildGitleaksArgs(sourceDir: string, reportPath: string): string[] {
    const args = [
      "detect",
      "--no-git",
      "--source",
      sourceDir,
      "--report-format",
      "json",
      "--report-path",
      reportPath,
      "--redact"
    ];

    if (process.env.GITLEAKS_CONFIG?.trim()) {
      args.push("--config", process.env.GITLEAKS_CONFIG);
    }

    return args;
  }

  private async readReport(reportPath: string): Promise<string> {
    try {
      await access(reportPath);
    } catch {
      return "[]";
    }

    try {
      return await readFile(reportPath, "utf8");
    } catch {
      return "[]";
    }
  }

  private parseReport(output: string): string[] {
    if (!output.trim()) {
      return [];
    }

    try {
      const parsed = JSON.parse(output) as unknown;
      const findings = Array.isArray(parsed) ? (parsed as GitleaksFinding[]) : [];
      return findings.map((finding) => {
        const location =
          finding.StartLine !== undefined && finding.StartColumn !== undefined
            ? `line ${finding.StartLine}:${finding.StartColumn}`
            : "line ?";
        const ruleId = finding.RuleID ?? "gitleaks";
        const description = finding.Description ?? "Sensitive value";
        return `[${ruleId}] ${description} (${location})`;
      });
    } catch {
      return [];
    }
  }

  private async runCommand(
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(this.gitleaksBin, args, {
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(`GITLEAKS_BINARY_MISSING:${this.gitleaksBin}`));
          return;
        }
        reject(new Error(`Failed to launch gitleaks at ${this.gitleaksBin}: ${error.message}`));
      });

      child.on("close", (code) => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1
        });
      });
    });
  }

  private async runCommandWithAutoInstall(
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      return await this.runCommand(args);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("GITLEAKS_BINARY_MISSING:")) {
        throw error;
      }

      await installGitleaksBinary();
      this.gitleaksBin = this.resolveGitleaksBin();
      return await this.runCommand(args);
    }
  }
}
