// The input rule (an arm sends input, never shortcuts around it): no script
// injection and no element-level shortcut on the send path of src/arm.ts.
// Stages and reads may run scripts; `send` must use W3C WebDriver Actions
// (`action("key" | "pointer" | "wheel")`) only.
//
//   node scripts/check-input-rule.ts [file]      (default: src/arm.ts)
//   node scripts/check-input-rule.ts --self-test (the gate fails on a planted call)
import { readFileSync } from "node:fs";

const FORBIDDEN =
  /\b(execute|executeAsync|executeScript|executeAsyncScript|addInitScript|\$eval|\$\$eval|setValue|addValue|clearValue|elementSendKeys|elementClick|elementClear|keys|click|doubleClick|dragAndDrop|moveTo|scrollIntoView|selectByVisibleText|selectByIndex|selectByAttribute|uploadFile)\s*\(/;

export function violations(source: string): string[] {
  const start = source.indexOf("// --- send: input only");
  const end = source.indexOf("// --- end send");
  if (start < 0 || end < start) return ["the send section markers are missing"];
  const out: string[] = [];
  const lines = source.slice(start, end).split("\n");
  const first = source.slice(0, start).split("\n").length;
  lines.forEach((l, i) => {
    const code = l.replace(/\/\/.*$/, "");
    if (FORBIDDEN.test(code)) out.push(`line ${first + i}: ${l.trim()}`);
  });
  return out;
}

const arg = process.argv[2];
if (arg === "--self-test") {
  const src = readFileSync("src/arm.ts", "utf8");
  for (const planted of [
    "await this.browser().execute(() => 0);",
    "await this.browser().keys(['a']);",
  ]) {
    const bad = src.replace("// --- end send", planted + "\n  // --- end send");
    if (violations(src).length !== 0 || violations(bad).length !== 1) {
      console.error(`input-rule gate self-test failed on: ${planted}`);
      process.exit(1);
    }
  }
  console.log(
    "input-rule gate catches a planted browser.execute and browser.keys",
  );
} else {
  const found = violations(readFileSync(arg ?? "src/arm.ts", "utf8"));
  for (const v of found)
    console.error(
      "script injection or an element shortcut on the send path:",
      v,
    );
  if (found.length) process.exit(1);
  console.log("input rule: the send path uses only W3C WebDriver Actions");
}
