// dvs-webdriverio: the WebDriverIO arm, serving DemoVideoScript's backend
// protocol as JSON lines on stdin and stdout.
//
//   node src/main.ts --binding <module.ts> [--defect stale-read|off-by-one|early-sync|read-side-effect]
//
// The binding module's default export is a Binding; it may also export
// `launch` (a Launch) to start a browser other than the default: headless
// Chromium (DVS_CHROME) through ChromeDriver (DVS_CHROMEDRIVER), driven over
// classic W3C WebDriver.
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { remote } from "webdriverio";
import { Arm } from "./arm.ts";
import type { Binding, Defect, Launch } from "./arm.ts";
import { BackendError } from "./surface.ts";

const args = process.argv.slice(2);
let bindingPath = "";
let defect: Defect = "none";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--binding") bindingPath = args[++i];
  else if (args[i] === "--defect") defect = args[++i] as Defect;
  else if (args[i].startsWith("--defect=")) defect = args[i].slice(9) as Defect;
  else {
    console.error("usage: main.ts --binding <module.ts> [--defect NAME]");
    process.exit(64);
  }
}
if (!bindingPath) {
  console.error("usage: main.ts --binding <module.ts> [--defect NAME]");
  process.exit(64);
}

export const chromium: Launch = async (opts) => {
  const chrome = process.env.DVS_CHROME;
  const driver = process.env.DVS_CHROMEDRIVER;
  if (!chrome || !driver)
    throw new Error("set DVS_CHROME and DVS_CHROMEDRIVER (the dev shell does)");
  const width = opts.width ?? 1024;
  const height = opts.height ?? 600;
  return await remote({
    logLevel: "error",
    capabilities: {
      browserName: "chrome",
      "wdio:enforceWebDriverClassic": true,
      "wdio:chromedriverOptions": { binary: driver },
      "goog:chromeOptions": {
        binary: chrome,
        args: [
          "--headless=new",
          `--window-size=${width},${height}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-gpu",
          "--hide-scrollbars",
        ],
      },
    },
  });
};

const mod = await import(pathToFileURL(resolve(bindingPath)).href);
const binding: Binding = mod.default;
const arm = new Arm(binding, defect, mod.launch ?? chromium);

const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue: Promise<void> = Promise.resolve();
rl.on("line", (line) => {
  queue = queue.then(async () => {
    if (!line.trim()) return;
    let req: any;
    try {
      req = JSON.parse(line);
    } catch {
      out({
        id: null,
        ok: false,
        error: { kind: "protocol", message: `not JSON: ${line.slice(0, 80)}` },
      });
      return;
    }
    try {
      const res = await arm.handle(req);
      out({ ...res, id: req.id, ok: true });
    } catch (e: any) {
      const kind = e instanceof BackendError ? e.kind : "internal";
      out({
        id: req.id ?? null,
        ok: false,
        error: { kind, message: String(e?.message ?? e) },
      });
    }
    if (req.call === "shutdown") process.exit(0);
  });
});
rl.on("close", () => {
  queue.then(() => arm.close()).then(() => process.exit(0));
});
// A stopped arm ends its WebDriver session: an orphaned browser would hold
// the runner's pipes open.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    arm.close().finally(() => process.exit(sig === "SIGTERM" ? 143 : 130));
  });
}
