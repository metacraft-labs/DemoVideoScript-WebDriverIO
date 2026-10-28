// The WebDriverIO arm: DemoVideoScript's backend protocol answered through
// WebDriverIO, for web pages and every target a WebDriver server drives.
//
// It contains no matching, waiting or timing logic of its own (the runner owns
// those): it answers locate, read, send, await, record and hit. A project
// supplies a Binding: its stages (which open the application), how its page
// objects are read, the conditions it detects, its binding resolver. Input is
// W3C WebDriver Actions — key, pointer and wheel input sources — and never
// script injection (scripts/check-input-rule.ts enforces that on the send
// path); stages and reads may run scripts, reads may not change the
// application (the runner probes for it).
//
// Input state is the WebDriver session's, kept per input source: a key or
// button an action leaves down stays down until an action of the same source
// releases it, so every action names the same three sources ("keyboard",
// "mouse", "wheel") and a scenario's `press` and `release` map onto the
// session directly. Every action is performed without
// WebDriverIO's automatic release, which would also lift the modifiers a
// scenario holds.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { BackendError, hit, readNode, SurfaceIndex } from "./surface.ts";
import type { SurfaceNode } from "./surface.ts";
import type { Locator } from "./protocol.ts";

export type Defect =
  | "none"
  | "stale-read"
  | "off-by-one"
  | "early-sync"
  | "read-side-effect";

export interface OpenOptions {
  width?: number;
  height?: number;
}

export interface ArmContext {
  browser: WebdriverIO.Browser | undefined;
  base: string;
  state: Record<string, unknown>;
  /** Starts the browser (once) and navigates it to `url`. */
  open(url: string, init?: OpenOptions): Promise<WebdriverIO.Browser>;
}

export interface Binding {
  name: string;
  roles: Record<string, { affordances: string[]; properties: string[] }>;
  stage(
    ctx: ArmContext,
    use: string,
    args: Record<string, unknown>,
  ): Promise<void>;
  surface(ctx: ArmContext): Promise<SurfaceNode>;
  condition(ctx: ArmContext, name: string): Promise<boolean | undefined>;
  resolveChord(ctx: ArmContext, operation: string): Promise<string | null>;
  anchor?(
    ctx: ArmContext,
    n: SurfaceNode,
    anchor: string,
  ): Promise<{ x: number; y: number } | undefined>;
  /** One cell or pixel, in the page's units: what the off-by-one arm moves by. */
  unit?: number;
  /** Removes what the stages made (temporary files); called when the arm stops. */
  close?(ctx: ArmContext): Promise<void>;
}

/** How the arm starts a browser: WebDriverIO's `remote`, with Chromium and
 *  ChromeDriver from the dev shell unless the caller gives other options. */
export type Launch = (opts: OpenOptions) => Promise<WebdriverIO.Browser>;

const CAPABILITIES = [
  "input.key",
  "input.chord",
  "input.text",
  "input.pointer.move",
  "input.pointer.click",
  "input.pointer.drag",
  "input.wheel",
  "input.hover",
  "observe.text",
  "observe.geometry",
  "observe.focus",
  "sync.event",
  "sync.visual-settle",
  "record.video",
  "record.still",
];

// W3C WebDriver key codes (https://www.w3.org/TR/webdriver2/#keyboard-actions)
const KEYS: Record<string, string> = {
  Enter: "",
  Esc: "",
  Tab: "",
  Backspace: "",
  Delete: "",
  Insert: "",
  Home: "",
  End: "",
  PageUp: "",
  PageDown: "",
  Up: "",
  Down: "",
  Left: "",
  Right: "",
  Space: " ",
  Plus: "+",
  Ctrl: "",
  Shift: "",
  Alt: "",
  Meta: "",
};
for (let n = 1; n <= 12; n++)
  KEYS[`F${n}`] = String.fromCharCode(0xe031 + n - 1);

const MODIFIERS = new Set(["Ctrl", "Shift", "Alt", "Meta"]);

function w3cKey(key: string): string {
  if (KEYS[key]) return KEYS[key];
  if ([...key].length === 1) return key;
  throw new BackendError("refused", `WebDriver has no key '${key}'`);
}

const BUTTONS: Record<string, 0 | 1 | 2> = { left: 0, middle: 1, right: 2 };

const sleep = (ms: number) =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));

function parseDuration(s: string): number {
  if (s.endsWith("ms")) return parseFloat(s);
  if (s.endsWith("s")) return parseFloat(s) * 1000;
  if (s.endsWith("m")) return parseFloat(s) * 60000;
  return parseFloat(s) * 1000;
}

export class Arm {
  private idx = new SurfaceIndex();
  private tree: SurfaceNode | undefined;
  private before: SurfaceNode | undefined;
  private stageClosed = false;
  private held = new Set<string>();
  private buttonDown: 0 | 1 | 2 | undefined;
  private recording:
    | {
        dir: string;
        frames: string;
        times: number[];
        running: boolean;
        loop: Promise<void>;
      }
    | undefined;
  readonly ctx: ArmContext;
  private binding: Binding;
  private defect: Defect;

  constructor(binding: Binding, defect: Defect, launch: Launch) {
    this.binding = binding;
    this.defect = defect;
    const self = this;
    this.ctx = {
      browser: undefined,
      base: ".",
      state: {},
      async open(url, init) {
        self.ctx.browser ??= await launch(init ?? {});
        await self.ctx.browser.url(url);
        return self.ctx.browser;
      },
    };
  }

  private browser(): WebdriverIO.Browser {
    if (!this.ctx.browser)
      throw new BackendError(
        "internal",
        "the application is not open (no stage opened it)",
      );
    return this.ctx.browser;
  }

  private async refresh(): Promise<SurfaceNode> {
    this.browser();
    this.tree = await this.binding.surface(this.ctx);
    return this.tree;
  }

  private async point(
    id: string,
    anchor?: string,
  ): Promise<{ x: number; y: number }> {
    const root = await this.refresh();
    const n = this.idx.lookup(root, id);
    let p = { x: n.x + n.w / 2, y: n.y + n.h / 2 };
    if (anchor && anchor !== "center") {
      const a = this.binding.anchor
        ? await this.binding.anchor(this.ctx, n, anchor)
        : undefined;
      if (!a)
        throw new BackendError(
          "unsupported",
          `no anchor '${anchor}' on ${n.role}`,
        );
      p = a;
    }
    if (this.defect === "off-by-one")
      p = { x: p.x, y: p.y + (this.binding.unit ?? 1) };
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }

  // --- send: input only -----------------------------------------------------
  // Everything below up to "end send" delivers input through W3C WebDriver
  // Actions. scripts/check-input-rule.ts refuses script injection here.

  /** Key actions: press and release each chord, with `mods` held around it. */
  private async keyActions(mods: string[], keys: string[]): Promise<void> {
    const k = this.browser().action("key", { id: "keyboard" });
    const added = mods.filter((m) => !this.held.has(m));
    for (const m of added) k.down(w3cKey(m));
    for (const key of keys) k.down(key).up(key);
    for (const m of [...added].reverse()) k.up(w3cKey(m));
    await k.perform(true);
  }

  private async withModifiers(
    mods: string[],
    f: () => Promise<void>,
  ): Promise<void> {
    const added = mods.filter((m) => !this.held.has(m));
    if (added.length) {
      const k = this.browser().action("key", { id: "keyboard" });
      for (const m of added) k.down(w3cKey(m));
      await k.perform(true);
    }
    try {
      await f();
    } finally {
      if (added.length) {
        const k = this.browser().action("key", { id: "keyboard" });
        for (const m of [...added].reverse()) k.up(w3cKey(m));
        await k.perform(true);
      }
    }
  }

  private pointer() {
    return this.browser().action("pointer", {
      id: "mouse",
      parameters: { pointerType: "mouse" },
    });
  }

  /** A realistic path as one pointer action: a move to each point at its time. */
  private pathMoves(
    p: ReturnType<Arm["pointer"]>,
    path: Array<[number, number, number]> | undefined,
  ) {
    if (!path) return p;
    let last = 0;
    for (const [x, y, t] of path) {
      p.move({
        x: Math.round(x),
        y: Math.round(y),
        origin: "viewport",
        duration: Math.max(0, Math.round(t - last)),
      });
      last = t;
    }
    return p;
  }

  private async send(action: any): Promise<void> {
    this.before = await this.refresh();
    const targets = action.targets ?? {};
    const timing = action.timing ?? {};
    if (action.ext)
      throw new BackendError(
        "unsupported",
        `no extension step '${action.ext}'`,
      );
    if (action.key !== undefined) {
      const key = typeof action.key === "string" ? action.key : action.key.key;
      if (MODIFIERS.has(key))
        throw new BackendError(
          "refused",
          `the ${key} key on its own is a modifier: press and release it`,
        );
      await this.keyActions([], [w3cKey(key)]);
    } else if (action.chord !== undefined) {
      for (const c of String(action.chord).split(" ")) {
        const parts = c.split("+");
        await this.keyActions(parts.slice(0, -1), [
          w3cKey(parts[parts.length - 1]),
        ]);
      }
    } else if (action.type !== undefined) {
      const text: string =
        typeof action.type === "string" ? action.type : action.type.text;
      const delays: number[] = timing.keyDelaysMs ?? [];
      const k = this.browser().action("key", { id: "keyboard" });
      let i = 0;
      for (const ch of text) {
        const d = Math.round(delays[i++] ?? 0);
        if (d > 0) k.pause(d);
        k.down(ch).up(ch);
      }
      await k.perform(true);
    } else if (action.press !== undefined || action.release !== undefined) {
      const isPress = action.press !== undefined;
      const v = isPress ? action.press : action.release;
      if (v.key !== undefined) {
        if (!MODIFIERS.has(v.key)) {
          throw new BackendError(
            "refused",
            `only a modifier is held between steps; '${v.key}' is pressed and released together`,
          );
        }
        const k = this.browser().action("key", { id: "keyboard" });
        if (isPress) {
          k.down(w3cKey(v.key));
          this.held.add(v.key);
        } else {
          k.up(w3cKey(v.key));
          this.held.delete(v.key);
        }
        await k.perform(true);
      } else {
        const p = await this.point(targets.target, v.anchor);
        const button = BUTTONS[v.button ?? "left"];
        const ptr = this.pathMoves(this.pointer(), timing.path).move({
          x: p.x,
          y: p.y,
          origin: "viewport",
        });
        if (isPress) {
          ptr.down({ button });
          this.buttonDown = button;
        } else {
          ptr.up({ button });
          this.buttonDown = undefined;
        }
        await ptr.perform(true);
      }
    } else if (action.move !== undefined || action.hover !== undefined) {
      const v = action.move ?? action.hover;
      const p = await this.point(targets.target, v.anchor);
      await this.pathMoves(this.pointer(), timing.path)
        .move({ x: p.x, y: p.y, origin: "viewport" })
        .perform(true);
      if (action.hover?.for) await sleep(parseDuration(action.hover.for));
    } else if (action.click !== undefined) {
      const v = action.click;
      const p = await this.point(targets.target, v.anchor);
      const button = BUTTONS[v.button ?? "left"];
      await this.withModifiers(v.modifiers ?? [], async () => {
        const ptr = this.pathMoves(this.pointer(), timing.path).move({
          x: p.x,
          y: p.y,
          origin: "viewport",
        });
        for (let c = 0; c < (v.count ?? 1); c++) {
          if (c > 0) ptr.pause(40);
          ptr.down({ button }).up({ button });
        }
        await ptr.perform(true);
      });
    } else if (action.drag !== undefined) {
      const v = action.drag;
      const from = await this.point(
        targets.from,
        typeof v.from === "object" ? v.from.anchor : undefined,
      );
      const via: Array<{ x: number; y: number }> = [];
      for (const id of targets.via ?? []) via.push(await this.point(id));
      const to = await this.point(
        targets.to,
        typeof v.to === "object" ? v.to.anchor : undefined,
      );
      const button = BUTTONS[v.button ?? "left"];
      await this.withModifiers(v.modifiers ?? [], async () => {
        const ptr = this.pathMoves(this.pointer(), timing.approach);
        ptr.move({ x: from.x, y: from.y, origin: "viewport" }).down({ button });
        for (const w of via)
          ptr.move({ x: w.x, y: w.y, origin: "viewport", duration: 80 });
        this.pathMoves(ptr, timing.path);
        ptr
          .move({ x: to.x, y: to.y, origin: "viewport", duration: 80 })
          .up({ button });
        await ptr.perform(true);
      });
    } else if (action.wheel !== undefined) {
      const v = action.wheel;
      const p = await this.point(targets.target, v.anchor);
      const unit = 100;
      const [dx, dy] = {
        up: [0, -unit],
        down: [0, unit],
        left: [-unit, 0],
        right: [unit, 0],
      }[v.direction as "up" | "down" | "left" | "right"];
      await this.pointer()
        .move({ x: p.x, y: p.y, origin: "viewport" })
        .perform(true);
      for (let k = 0; k < (v.amount ?? 1); k++) {
        await this.browser()
          .action("wheel", { id: "wheel" })
          .scroll({ x: p.x, y: p.y, deltaX: dx, deltaY: dy, duration: 0 })
          .perform(true);
      }
    } else {
      throw new BackendError(
        "protocol",
        `send: no input action in ${JSON.stringify(action)}`,
      );
    }
    this.idx.clear();
  }
  // --- end send ---------------------------------------------------------------

  private async settled(timeoutMs: number): Promise<boolean> {
    // the page stopped changing: three reads of the surface, 60 ms apart,
    // agree (two consecutive quiet windows, as the other backends require)
    const deadline = Date.now() + timeoutMs;
    let last = JSON.stringify(await this.binding.surface(this.ctx));
    let quiet = 0;
    while (Date.now() < deadline) {
      await sleep(60);
      const now = JSON.stringify(await this.binding.surface(this.ctx));
      if (now === last) {
        quiet++;
        if (quiet >= 2) return true;
      } else quiet = 0;
      last = now;
    }
    return false;
  }

  async handle(req: any): Promise<Record<string, unknown>> {
    switch (req.call) {
      case "hello":
        return {
          backend: "webdriverio",
          version: "1",
          platform:
            process.platform === "darwin"
              ? "macos"
              : process.platform === "win32"
                ? "windows"
                : "linux",
          capabilities: CAPABILITIES,
          bindings: this.binding.roles,
          units: "px",
        };
      case "stage":
        if (this.stageClosed)
          throw new BackendError(
            "stage-closed",
            `the stage has ended; '${req.use}' cannot run now`,
          );
        this.ctx.base = req.with?.$base ?? ".";
        try {
          await this.binding.stage(this.ctx, req.use, req.with ?? {});
        } catch (e: any) {
          if (e instanceof BackendError) throw e;
          throw new BackendError("stage", `${req.use}: ${e?.message ?? e}`);
        }
        return {};
      case "end-stage":
        this.stageClosed = true;
        return {};
      case "resolve-chord":
        return {
          chord: await this.binding.resolveChord(this.ctx, req.operation),
        };
      case "locate": {
        const root = await this.refresh();
        return this.idx.locate(root, req.locator as Locator);
      }
      case "read": {
        const root =
          this.defect === "stale-read" && this.before
            ? this.before
            : await this.refresh();
        const n = this.idx.lookup(root, req.instance);
        const values = readNode(n, req.properties);
        if (this.defect === "read-side-effect" && n.role !== root.role) {
          await this.withModifiers(["Ctrl"], async () => {
            const x = Math.round(n.x + 2);
            const y = Math.round(n.y + n.h / 2);
            await this.pointer()
              .move({ x, y, origin: "viewport" })
              .down({ button: 0 })
              .up({ button: 0 })
              .perform(true);
          });
        }
        return { values };
      }
      case "send":
        await this.send(req.action);
        return {};
      case "await": {
        if (this.defect === "early-sync") return { met: true };
        if (req.condition === "settled")
          return { met: await this.settled(req.timeoutMs) };
        const deadline = Date.now() + req.timeoutMs;
        for (;;) {
          const met = await this.binding.condition(this.ctx, req.condition);
          if (met === undefined) {
            throw new BackendError(
              "unsupported",
              `the ${this.binding.name} binding cannot detect '${req.condition}'`,
            );
          }
          if (met) return { met: true };
          if (Date.now() > deadline) return { met: false };
          await sleep(20);
        }
      }
      case "record":
        return await this.record(req);
      case "hit":
        return { locator: hit(await this.refresh(), req.x, req.y) };
      case "shutdown":
        await this.close();
        return {};
      default:
        throw new BackendError("protocol", `unknown call '${req.call}'`);
    }
  }

  // --- recordings: WebDriver has no video, so the arm screenshots the page
  // while it records and encodes the frames with ffmpeg, each shown for as
  // long as it was on screen.
  private async record(req: any): Promise<{ files: string[] }> {
    switch (req.op) {
      case "start": {
        this.browser();
        const frames = mkdtempSync(join(tmpdir(), "dvs-wd-frames-"));
        const rec = {
          dir: req.dir as string,
          frames,
          times: [] as number[],
          running: true,
          loop: Promise.resolve(),
        };
        rec.loop = (async () => {
          while (rec.running) {
            const t = Date.now();
            try {
              const png = await this.browser().takeScreenshot();
              writeFileSync(
                join(
                  frames,
                  `${String(rec.times.length).padStart(6, "0")}.png`,
                ),
                png,
                "base64",
              );
              rec.times.push(t);
            } catch {
              // the page navigated or closed mid-shot: the next frame covers it
            }
            await sleep(200 - (Date.now() - t));
          }
        })();
        this.recording = rec;
        return { files: [] };
      }
      case "mark":
        return { files: [] };
      case "still": {
        const path = join(req.dir ?? ".", `${req.path ?? "still"}.png`);
        mkdirSync(dirname(path), { recursive: true });
        await this.browser().saveScreenshot(path);
        return { files: [path] };
      }
      case "stop": {
        const rec = this.recording;
        this.recording = undefined;
        if (!rec) return { files: [] };
        rec.running = false;
        await rec.loop;
        try {
          if (rec.times.length === 0) return { files: [] };
          mkdirSync(rec.dir, { recursive: true });
          const list = rec.times.map((t, i) => {
            const next = rec.times[i + 1] ?? Date.now();
            return `file '${join(rec.frames, `${String(i).padStart(6, "0")}.png`)}'\nduration ${((next - t) / 1000).toFixed(3)}`;
          });
          // the concat demuxer needs the last file once more to honour its duration
          list.push(
            `file '${join(rec.frames, `${String(rec.times.length - 1).padStart(6, "0")}.png`)}'`,
          );
          writeFileSync(join(rec.frames, "list.txt"), list.join("\n") + "\n");
          const out = join(rec.dir, "session.webm");
          const ff = spawnSync(
            process.env.FFMPEG_BIN ?? "ffmpeg",
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-y",
              "-f",
              "concat",
              "-safe",
              "0",
              "-i",
              join(rec.frames, "list.txt"),
              "-vf",
              "pad=ceil(iw/2)*2:ceil(ih/2)*2",
              "-c:v",
              "libvpx-vp9",
              "-b:v",
              "1M",
              "-pix_fmt",
              "yuv420p",
              "-r",
              "10",
              out,
            ],
            { encoding: "utf8" },
          );
          if (ff.status !== 0)
            throw new BackendError(
              "internal",
              `encoding the video: ${ff.stderr}`,
            );
          return { files: [out] };
        } finally {
          rmSync(rec.frames, { recursive: true, force: true });
        }
      }
    }
    throw new BackendError("protocol", `unknown record op '${req.op}'`);
  }

  async close(): Promise<void> {
    if (this.recording) {
      this.recording.running = false;
      await this.recording.loop.catch(() => {});
      rmSync(this.recording.frames, { recursive: true, force: true });
      this.recording = undefined;
    }
    const b = this.ctx.browser;
    this.ctx.browser = undefined;
    await b?.deleteSession().catch(() => {});
    await this.binding.close?.(this.ctx).catch(() => {});
  }
}
