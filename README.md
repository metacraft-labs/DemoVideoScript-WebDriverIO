# DemoVideoScript-WebDriverIO

The [DemoVideoScript](https://github.com/metacraft-labs/DemoVideoScript) scenario arm for
web pages and every target a WebDriver server drives (a browser, an Electron
application, VS Code through its WebDriver service), through
[WebDriverIO](https://webdriver.io/). It is a small TypeScript process that answers
DemoVideoScript's backend protocol (JSON lines on stdio): the runner sends it `locate`,
`read`, `send`, `await`, `record` and `hit`, and it answers through a real WebDriver
session. All matching, waiting and timing is the runner's; the arm only observes and
delivers input.

A project supplies a **binding**, a TypeScript module whose default export is a
`Binding` (`src/arm.ts`): its stages (which open the application), how its page objects
are read, the conditions it can detect, and its binding resolver. A binding may also
export `launch` to start its own WebDriver session (for VS Code, its WebDriver service);
the default is headless Chromium through ChromeDriver.

**Input is W3C WebDriver Actions.** Keys, the pointer and the wheel are input sources of
the session, and their state is the session's: a key or a button a step presses stays
down until a step releases it. The arm never injects scripts or uses element shortcuts
(`click`, `setValue`) to change the application; `just lint` refuses them on the send
path. Stages may run scripts (they run before the steps), and reads may introspect the
page but not change it — the runner reads twice and compares.

WebDriver has no video: while a run records, the arm takes a screenshot every 200 ms and
encodes the frames with `ffmpeg` into a WebM video, each shown for as long as it was on
screen; stills are a PNG per step. Message types (`src/protocol.ts`) are generated from
DemoVideoScript's published schema and checked against it.

```sh
dvs run scenario.yaml --pack my-app.pack.yaml \
  --backend "cmd:node src/main.ts --binding my-binding.ts"
```

`conformance/notes-binding.ts` binds DemoVideoScript's conformance application and is
the worked example.

## Developing

DemoVideoScript is expected at `../DemoVideoScript` (or `DVS_ROOT`). Node, TypeScript,
Chromium, ChromeDriver and `ffmpeg` come from the dev shell, and WebDriverIO with its
dependencies exactly as `package-lock.json` pins them, fetched by Nix (no install
scripts run, nothing is downloaded at run time).

| Recipe                                         | Does                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `just build`                                   | links `node_modules`, and builds the runner and the conformance application's web build                                         |
| `just test`                                    | the conformance suite through the runner (fast and realistic, with every planted defect), the protocol check, and the arm suite |
| `just lint`                                    | the type check, the generated types against the schema, the input rule, the neutrality scan, `nixfmt`                           |
| `python3 tests/mutation/run-dvs6-mutations.py` | every planted defect in the arm must turn the tests red                                                                         |

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
