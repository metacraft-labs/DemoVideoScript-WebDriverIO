// A binding whose stage starts a detached child process, as WebDriverIO starts
// ChromeDriver and as a binding may start an application or a server, and writes
// its pid to $DVS_TEST_CHILD_PID_FILE. The child is a real process (`sleep`);
// no browser is needed to show whether the arm leaves it running.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Binding } from "../../src/arm.ts";

const binding: Binding = {
  name: "spawning",
  roles: {},
  async stage(_ctx, use) {
    if (use !== "start-child") throw new Error(`no stage procedure '${use}'`);
    const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
    child.unref();
    writeFileSync(process.env.DVS_TEST_CHILD_PID_FILE!, String(child.pid));
  },
  async surface() {
    return { role: "screen", keys: [], props: {}, x: 0, y: 0, w: 1, h: 1, visible: true, children: [] };
  },
  async condition() {
    return undefined;
  },
  async resolveChord() {
    return null;
  },
};

export default binding;
