import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface CodeCliHost {
  appRoot: string;
  remote: boolean;
  platform: NodeJS.Platform;
  execPath: string;
}

export interface CodeCliLaunch {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export async function resolveCodeCliLaunch(
  host: CodeCliHost,
  target: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CodeCliLaunch> {
  const env = { ...environment };
  if (host.remote && !env.VSCODE_IPC_HOOK_CLI) {
    throw new Error("The current remote VS Code window has no CLI connection. Reload the window and try again.");
  }
  const product = JSON.parse(await fs.readFile(path.join(host.appRoot, "product.json"), "utf8")) as { applicationName?: string; nameShort?: string; commit?: string };
  const applicationName = product.applicationName;
  if (!applicationName || !/^[\w.-]+$/.test(applicationName)) {
    throw new Error("Cannot determine the VS Code CLI name from product.json.");
  }
  if (host.remote) {
    // The remote extension host's pipe identifies this window. Do not let an
    // inherited WSL client command route the request to another installation.
    delete env.VSCODE_CLIENT_COMMAND;
    delete env.VSCODE_CLIENT_COMMAND_CWD;
  }
  if (host.platform !== "win32") {
    const executable = host.remote
      ? path.join(host.appRoot, "bin", "remote-cli", applicationName)
      : path.join(host.appRoot, "bin", applicationName);
    await fs.access(executable, fs.constants.X_OK);
    return { executable, args: ["-r", "--", target], env };
  }
  // Windows code.cmd is a wrapper around this exact CLI. Invoke the entry
  // point directly so cmd.exe cannot expand %, &, or other path characters.
  const cli = path.join(host.appRoot, "out", host.remote ? "server-cli.js" : "cli.js");
  await fs.access(cli);
  const prefix = [cli];
  if (host.remote) {
    const pkg = JSON.parse(await fs.readFile(path.join(host.appRoot, "package.json"), "utf8")) as { version: string };
    prefix.push(product.nameShort ?? applicationName, pkg.version, product.commit ?? "", applicationName);
  } else {
    env.ELECTRON_RUN_AS_NODE = "1";
    delete env.VSCODE_DEV;
  }
  return { executable: host.execPath, args: [...prefix, "-r", "--", target], env };
}

export function runCodeCli(launch: CodeCliLaunch): Promise<void> {
  return new Promise((resolve, reject) => {
    // No shell or terminal input: every path is passed as one literal argument.
    execFile(launch.executable, launch.args, {
      env: launch.env, windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024,
      encoding: "utf8", shell: false,
    }, (error, stdout, stderr) => {
      // Some remote CLI failures are printed without setting a nonzero exit code.
      const reportedFailure = /Error when invoking the open command:|Unable to connect to VS Code server:/.test(stderr) ||
        /Command is only available in WSL or inside a Visual Studio Code terminal\./.test(stdout);
      if (error || reportedFailure) {
        const detail = (stderr.trim() || stdout.trim() || error?.message || "Unknown CLI error").slice(0, 2000);
        reject(new Error(`code -r failed: ${detail}`));
      } else {
        resolve();
      }
    });
  });
}

export async function openWithCodeCli(host: CodeCliHost, target: string): Promise<void> {
  await runCodeCli(await resolveCodeCliLaunch(host, target));
}
