import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute, delimiter } from "node:path";

export type VerifyCheck = {
  name: string;
  ok: boolean;
  detail?: string;
};

export type VerifyOutcome = {
  ok: boolean;
  checks: VerifyCheck[];
  pending: string[];
  feedback: string;
};

export type Acceptance = {
  type: string;
  run?: string;
  pattern?: string;
  paths?: string[];
  text?: string;
  expect?: string;
};

export type VerifyRunner = (
  cmd: string,
  args: string[],
  o: {
    cwd: string;
    timeoutMs: number;
    env: Record<string, string>;
  },
) => Promise<{ code: number | null; output: string }>;

export const defaultVerifyRunner: VerifyRunner = (cmd, args, options) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`;
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? Number((error as NodeJS.ErrnoException).code)
            : error
              ? null
              : 0;
        resolve({ code, output });
      },
    );
  });

function tail(text: string, length = 1200): string {
  return text.slice(-length);
}

function safeRelativePath(path: string): boolean {
  return !isAbsolute(path) && !path.split(/[\\/]+/).includes("..");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function commandDetail(result: { code: number | null; output: string }): string {
  return tail(result.output || `exit code ${String(result.code)}`);
}

export function resolveNodeRunner(
  env = process.env,
  execPath = process.execPath,
  isElectron = Boolean((process.versions as any).electron),
  fileExists = existsSync,
): { cmd: string; extraEnv: Record<string, string> } {
  if (env.NHD_NODE_PATH && fileExists(env.NHD_NODE_PATH)) {
    return { cmd: env.NHD_NODE_PATH, extraEnv: {} };
  }
  if (!isElectron) {
    return { cmd: execPath, extraEnv: {} };
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    const nodeExe = join(dir, "node.exe");
    if (fileExists(nodeExe)) {
      return { cmd: nodeExe, extraEnv: {} };
    }
    const node = join(dir, "node");
    if (fileExists(node)) {
      return { cmd: node, extraEnv: {} };
    }
  }
  return { cmd: execPath, extraEnv: { ELECTRON_RUN_AS_NODE: "1" } };
}

export async function verifyPatchInCopy(o: {
  projectRoot: string;
  patch: string;
  acceptance: Acceptance[];
  tmpRoot: string;
  timeoutMs?: number;
  run?: VerifyRunner;
}): Promise<VerifyOutcome> {
  const run = o.run ?? defaultVerifyRunner;
  const timeoutMs = o.timeoutMs ?? 180000;
  const dir = await mkdtemp(join(o.tmpRoot, "sbce-verify-"));
  const checks: VerifyCheck[] = [];
  const pending: string[] = [];
  const scratchTemp = join(dir, ".tmp");
  await mkdir(scratchTemp, { recursive: true });
  const nodeRunner = resolveNodeRunner();
  // Tests may create temp dirs; keep them inside the copy so --allow-fs-write=<copy> covers them.
  const env = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    ...nodeRunner.extraEnv,
    TEMP: scratchTemp,
    TMP: scratchTemp,
  };

  try {
    for (const name of ["package.json", "tsconfig.json", "src", "test"]) {
      const source = join(o.projectRoot, name);
      if (await exists(source)) {
        await cp(source, join(dir, name), { recursive: true });
      }
    }

    const projectNodeModules = join(o.projectRoot, "node_modules");
    if (await exists(projectNodeModules)) {
      await linkNodeModules(projectNodeModules, join(dir, "node_modules"));
    }

    await writeFile(join(dir, ".sbce.patch"), o.patch);
    const patchResult = await run("git", ["apply", "--whitespace=nowarn", ".sbce.patch"], {
      cwd: dir,
      timeoutMs,
      env,
    });

    if (patchResult.code !== 0) {
      checks.push({
        name: "patch_applies",
        ok: false,
        detail: `Patch does not apply: ${tail(patchResult.output)}`,
      });
      return {
        ok: false,
        checks,
        pending,
        feedback: `patch_applies: ${tail(`Patch does not apply: ${patchResult.output}`)}`.slice(-1500),
      };
    }

    checks.push({ name: "patch_applies", ok: true });

    let buildResult: { code: number | null; output: string } | undefined;
    let buildStarted = false;
    const ensureBuilt = async (): Promise<{ code: number | null; output: string }> => {
      if (!buildStarted) {
        buildStarted = true;
        buildResult = await run(
          nodeRunner.cmd,
          [join(dir, "node_modules", "typescript", "bin", "tsc"), "-p", "."],
          { cwd: dir, timeoutMs, env },
        );
      }
      return buildResult!;
    };

    for (const item of o.acceptance) {
      if (item.type === "artifact_exists" && item.paths) {
        const offending: string[] = [];
        for (const path of item.paths) {
          if (!safeRelativePath(path) || !(await exists(join(dir, path)))) {
            offending.push(path);
          }
        }
        checks.push({
          name: "artifact_exists",
          ok: offending.length === 0,
          ...(offending.length > 0 ? { detail: offending.join(", ") } : {}),
        });
        continue;
      }

      if (item.type === "grep_absent" && item.pattern && item.paths) {
        const offending: string[] = [];
        try {
          const expression = new RegExp(item.pattern);
          for (const path of item.paths) {
            if (!safeRelativePath(path)) {
              offending.push(path);
              continue;
            }
            const target = join(dir, path);
            if (!(await exists(target))) {
              continue;
            }
            const contents = await readFile(target, "utf8");
            if (expression.test(contents)) {
              offending.push(path);
            }
          }
          checks.push({
            name: "grep_absent",
            ok: offending.length === 0,
            ...(offending.length > 0 ? { detail: offending.join(", ") } : {}),
          });
        } catch (error) {
          checks.push({
            name: "grep_absent",
            ok: false,
            detail: String(error),
          });
        }
        continue;
      }

      const command = item.run?.trim() ?? "";
      if (/^(npx tsc( --noEmit)?( -p \.)?|npm run build)$/.test(command)) {
        const result = await ensureBuilt();
        checks.push({
          name: "typecheck",
          ok: result.code === 0,
          ...(result.code === 0 ? {} : { detail: commandDetail(result) }),
        });
        continue;
      }

      if (/^node --test( test\/[\w.\/-]+)+$/.test(command) && !command.includes("..")) {
        const result = await ensureBuilt();
        if (result.code !== 0) {
          if (!checks.some((c) => c.name === "typecheck")) {
            checks.push({
              name: "typecheck",
              ok: false,
              detail: commandDetail(result),
            });
          }
          checks.push({
            name: "tests",
            ok: false,
            detail: "Tests were not run because typecheck failed.",
          });
          continue;
        }

        const paths = command.split(/\s+/).slice(2);
        const testResult = await run(
          nodeRunner.cmd,
          [
            "--permission",
            `--allow-fs-read=${dir}`,
            `--allow-fs-read=${projectNodeModules}`,
            `--allow-fs-write=${dir}`,
            "--test",
            "--test-isolation=none",
            ...paths,
          ],
          { cwd: dir, timeoutMs, env },
        );
        if (testResult.code !== 0 && /ERR_ACCESS_DENIED/.test(testResult.output)) {
          // The sandbox, not the patch, blocked the run (Node --permission cannot grant some paths,
          // e.g. \\?\-prefixed ancestor stats from fs.cp on Windows). Hand it to the Brain instead
          // of blaming the worker.
          pending.push(`${command} (blocked by verify sandbox: ERR_ACCESS_DENIED; run outside sandbox)`);
          continue;
        }
        checks.push({
          name: "tests",
          ok: testResult.code === 0,
          ...(testResult.code === 0 ? {} : { detail: commandDetail(testResult) }),
        });
        continue;
      }

      pending.push(item.run ?? item.text ?? item.type);
    }

    const failures = checks.filter((check) => !check.ok);
    const feedback = failures
      .map((check) => `${check.name}: ${check.detail ?? "failed"}`)
      .join("\n")
      .slice(0, 1500);

    return {
      ok: failures.length === 0,
      checks,
      pending,
      feedback,
    };
  } finally {
    try {
      const nodeModules = join(dir, "node_modules");
      if (await exists(nodeModules)) {
        await unlink(nodeModules);
      }
    } catch {
      // Cleanup is best effort.
    }
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Cleanup is best effort.
    }
  }
}

async function linkNodeModules(source: string, destination: string): Promise<void> {
  const { symlink } = await import("node:fs/promises");
  await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
}
