#!/usr/bin/env python3
"""DVS-6 verification gate: the WebDriverIO arm.

Each arm is a defect in locating, input, observation or the generated protocol
types; the kill command is the arm's lint (type check, generated types, input
rule) followed by the arm suite, the conformance suite through the runner with
its planted defects, and the protocol check, in a real browser over WebDriver.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mutation_engine import Arm, main  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
S = "src/surface.ts"
A = "src/arm.ts"
P = "src/protocol.ts"

ARMS = [
    Arm("W1", S, "      } else if (pool.length > 1) {", "      } else if (false) {",
        "a locator resolving the first of several candidates instead of reporting ambiguity"),
    Arm("W2", A, "      for (const m of added) k.down(w3cKey(m));\n      await k.perform(true);",
        "      for (const m of added) void m;\n      await k.perform(true);",
        "a click's modifiers dropped"),
    Arm("W3", A, "    this.tree = await this.binding.surface(this.ctx);",
        "    this.tree ??= await this.binding.surface(this.ctx);", "a stale read: the page is not re-read"),
    Arm("W4", P, '  "outcome": "one" | "none" | "ambiguous";', '  "outcome": "one" | "none";',
        "the protocol types drifting from the schema"),
    Arm("W5", A, "    if (action.ext)\n", "    await this.browser().execute(() => 0);\n    if (action.ext)\n",
        "script injection on the send path"),
    Arm("W6", A, "        if (quiet >= 2) return true;", "        if (quiet >= 1) return true;",
        "settled after one quiet window: before the page stopped changing"),
    Arm("W7", A, "          k.down(w3cKey(v.key));\n          this.held.add(v.key);",
        "          this.held.add(v.key);", "a held modifier never pressed"),
    Arm("W8", A, "        await k.perform(true);\n      } else {\n        const p = await this.point(targets.target, v.anchor);",
        "        await k.perform();\n      } else {\n        const p = await this.point(targets.target, v.anchor);",
        "a held modifier released at once by WebDriverIO's automatic release"),
    Arm("W9", A, "        for (let c = 0; c < (v.count ?? 1); c++) {", "        for (let c = 0; c < 1; c++) {",
        "a double click delivered as one click"),
    Arm("W10", A, 'const k = this.browser().action("key", { id: "keyboard" });\n        if (isPress) {',
        'const k = this.browser().action("key", { id: `keyboard-${Date.now()}` });\n        if (isPress) {',
        "a held modifier pressed and released on different input sources"),
]

if __name__ == "__main__":
    main("dvs6", ROOT, ARMS, ["bash", "-c", "just lint-types lint-input-rule && "
                                              "just build test-arm && just test-conformance test-protocol"])
