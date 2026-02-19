import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

type CommandStep = {
  bin: string;
  args: string[];
};

type Installer = {
  steps: CommandStep[];
};

export async function installGitleaksBinary(): Promise<void> {
  const installers = getInstallersForCurrentPlatform();
  let lastError = "";

  for (const installer of installers) {
    const firstBin = installer.steps[0]?.bin;
    if (firstBin && firstBin.includes("/") && !existsSync(firstBin)) {
      continue;
    }

    try {
      let failed = false;
      for (const step of installer.steps) {
        const result = await runInstallCommand(step.bin, step.args);
        if (result.exitCode !== 0) {
          lastError = result.stderr || result.stdout || `${step.bin} exited with code ${result.exitCode}`;
          failed = true;
          break;
        }
      }

      if (!failed) {
        return;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(
    `Unable to auto-install gitleaks on ${process.platform}: ${lastError || "no package manager available"}`
  );
}

function getInstallersForCurrentPlatform(): Installer[] {
  if (process.platform === "darwin") {
    return [
      { steps: [{ bin: "/opt/homebrew/bin/brew", args: ["install", "gitleaks"] }] },
      { steps: [{ bin: "/usr/local/bin/brew", args: ["install", "gitleaks"] }] },
      { steps: [{ bin: "brew", args: ["install", "gitleaks"] }] }
    ];
  }

  if (process.platform === "win32") {
    return [
      { steps: [{ bin: "winget", args: ["install", "--id", "Gitleaks.Gitleaks", "--silent"] }] },
      { steps: [{ bin: "choco", args: ["install", "gitleaks", "-y"] }] },
      { steps: [{ bin: "scoop", args: ["install", "gitleaks"] }] }
    ];
  }

  return [
    {
      steps: [
        { bin: "apt-get", args: ["update"] },
        { bin: "apt-get", args: ["install", "-y", "gitleaks"] }
      ]
    },
    { steps: [{ bin: "dnf", args: ["install", "-y", "gitleaks"] }] },
    { steps: [{ bin: "yum", args: ["install", "-y", "gitleaks"] }] },
    { steps: [{ bin: "pacman", args: ["-Sy", "--noconfirm", "gitleaks"] }] },
    { steps: [{ bin: "zypper", args: ["--non-interactive", "install", "gitleaks"] }] },
    { steps: [{ bin: "apk", args: ["add", "gitleaks"] }] }
  ];
}

function runInstallCommand(
  bin: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
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
      reject(error);
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
