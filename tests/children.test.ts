// The arm does not leave behind what it started. WebDriverIO starts
// ChromeDriver detached; a run whose arm exited left the driver and its
// browser running, reparented, for hours (22 of them on one host, about 64 %
// CPU each). Here the binding's stage starts a real detached process, and the
// arm is ended the three ways a run ends it: its input closes (the runner is
// done), SIGTERM, and SIGHUP. Each time the process must be gone. The child
// is `sleep`, not a browser: what is checked is the arm's process lifecycle,
// which does not depend on what the child is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(f: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return f();
}

async function runArm(end: "stdin" | "SIGTERM" | "SIGHUP"): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "dvs-wd-children-"));
  const pidFile = join(dir, "child.pid");
  try {
    const arm = spawn("node", [join(root, "src/main.ts"), "--binding", join(root, "tests/support/spawning-binding.ts")], {
      env: { ...process.env, DVS_TEST_CHILD_PID_FILE: pidFile },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const exited = new Promise<void>((r) => arm.on("exit", () => r()));
    arm.stdin.write(JSON.stringify({ id: 1, call: "stage", use: "start-child", with: {} }) + "\n");
    assert.ok(await until(() => existsSync(pidFile), 20_000), "the stage started its child");
    const child = parseInt(readFileSync(pidFile, "utf8"), 10);
    assert.ok(alive(child), "the child runs while the arm does");
    if (end === "stdin") arm.stdin.end();
    else arm.kill(end);
    await exited;
    return child;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const end of ["stdin", "SIGTERM", "SIGHUP"] as const) {
  test(`an arm ended by ${end === "stdin" ? "its input closing" : end} leaves no child running`, { timeout: 60_000 }, async () => {
    const child = await runArm(end);
    const gone = await until(() => !alive(child), 5_000);
    if (!gone) process.kill(child, "SIGKILL");
    assert.ok(gone, `pid ${child}, started by the binding, outlived the arm`);
  });
}
