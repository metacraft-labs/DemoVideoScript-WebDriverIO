# DemoVideoScript-WebDriverIO

DemoVideoScript backend arm that runs scenarios on WebDriver targets, such as VS Code extensions, through WebDriverIO.

> **Status:** ☐ Planned — design stage; no implementation yet.

A thin TypeScript process that answers the
[DemoVideoScript](https://github.com/metacraft-labs/DemoVideoScript) backend protocol
(JSON lines over stdio) using [WebDriverIO](https://webdriver.io/): element queries for
observation and W3C WebDriver Actions for input. It contains no matching, waiting or timing
logic of its own. Also carries the WebDriver binding of the DemoVideoScript conformance
application.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
