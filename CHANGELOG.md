# Changelog

## [0.3.1](https://github.com/wridgeu/ui5-middleware-ws-mock/compare/v0.3.0...v0.3.1) (2026-05-13)


### Code Refactoring

* **middleware:** drop redundant undefined-onError arg in socket-error invoke call ([e530bee](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/e530beec1e4e418e15bd73fc67176e07872dd77a))
* **middleware:** surface connection errors via onError hook and server listeners ([b730b61](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/b730b619ca25873f319cc729c3e4215c82417db7))
* **pcp:** widen bodyType union and cache unescape regex ([2377143](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/2377143326e8d23a88f226d6627f8645f93e0002))
* **types:** mode-discriminated ctx with PCP-aware send overload ([f711acb](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/f711acb4c13c39be0bafc0c444217b687b50c95a))

## [0.3.0](https://github.com/wridgeu/ui5-middleware-ws-mock/compare/v0.2.1...v0.3.0) (2026-05-11)


### ⚠ BREAKING CHANGES

* **middleware:** handler paths now resolve under `<project>/webapp/` by default instead of the project root. Existing configs typically need a one-line tweak: either drop a now-redundant `webapp/` prefix from each `handler` value (so `./webapp/wsmock/foo.ts` becomes `wsmock/foo.ts`), or pin `rootPath: "."` to keep the previous project-root resolution unchanged. Configs that already used bare paths under `webapp/` (e.g. `handler: webapp/wsmock/foo.ts`) will silently resolve to a doubled `webapp/webapp/...` path under the new default and fail to load — same one-line fix applies.

### Bug Fixes

* **middleware:** catch getSourcePath() throws on non-Application projects ([45ca45f](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/45ca45f5db618463362413e57fc355c5b21e3490))
* **middleware:** default handler resolution to source path, add rootPath ([ac5c7c8](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/ac5c7c80567a326896ddbd8546bc44fb7d9fc344))
* **middleware:** drop getSourcePath() fallback, let it throw on non-Application projects ([aea43cc](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/aea43cc5afee78a7b38b623a9ba80b2bd7dfdd7f))
* **middleware:** skip handler-root resolution when routes is empty ([df770cc](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/df770cc99680ac0ddfd5880501926ec1f221738d))

## [0.2.1](https://github.com/wridgeu/ui5-middleware-ws-mock/compare/v0.2.0...v0.2.1) (2026-05-08)


### Bug Fixes

* **middleware:** hoist ws error listener so refused connections cannot crash the process ([0edd3c7](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/0edd3c7e72dce29abdddac5ee611883e8f00fcae))
* **middleware:** log verbose on malformed PCP frames ([acb6f53](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/acb6f53bd674271ca4322e9359bf1e97104ad15f))
* **middleware:** log verbose on unparseable upgrade urls ([1ac335e](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/1ac335ee358c9d1c1acd8e16a8832548cddf4863))


### Code Refactoring

* **pcp:** drop redundant String() coercion in pcpEscape ([682482b](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/682482bf7d7ae3840066aa33e14a9ce37f542931))
* **types:** extract WebSocketMode and dedupe FactoryParameters.log ([3b47e8a](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/3b47e8a700779c9f2088446f494c6afd3ec85a99))

## [0.2.0](https://github.com/wridgeu/ui5-middleware-ws-mock/compare/v0.1.1...v0.2.0) (2026-05-06)


### ⚠ BREAKING CHANGES

* **log:** `ctx.log.debug` is removed; use `ctx.log.verbose`. `ctx.log.silly` and `ctx.log.perf` are added. The structural `FactoryParameters.log` type now requires the six v4 level methods; versions of `@ui5/logger` older than v4 are not supported.
* ctx.send signature changes from ({ action, data }) => void to (message: string) => void. The WebSocketHandler.actions map is removed. WebSocketInboundFrame ({ action, data, raw }) is replaced by InboundMessage = string | PcpFrame. Existing handlers that relied on the action-routing convention or the JSON envelope must migrate to onMessage with a ctx.mode branch; see the README for the user-land routing recipe.

### Features

* drop action routing and payload encoding from middleware ([3ee7da6](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/3ee7da6138619fd40c587f82668fb7e5fac7b846))


### Bug Fixes

* **log:** bind ctx.log methods and align with @ui5/logger v4 levels ([411ce09](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/411ce09b1c7bfea843f3639bc57578322d5d9ad5))
* route package main + exports through dist/index.js ([9961d17](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/9961d1714f1c13e6842ebd339665db6995b00325))


### Code Refactoring

* drop dead encode try/catch in ctx.send ([f16ca4c](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/f16ca4c70726f95251cb3dbe275f4ef690ae67c3))
* **pcp:** use map() in pcpUnescape and drop non-null assertion ([d7560b9](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/d7560b97825c30e520f2d85ca17c9c45c097c4fe))

## [0.1.1](https://github.com/wridgeu/ui5-middleware-ws-mock/compare/v0.1.0...v0.1.1) (2026-05-04)


### Code Refactoring

* drop redundant non-null assertions and casts in dispatch ([e23b1f6](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/e23b1f67070016cfa2cc3b84fa58a60bae626f33))

## 0.1.0 (2026-05-04)


### Features

* initial implementation of ui5-middleware-ws-mock ([eec9848](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/eec98483f64bf5861ae51c1bb96e2a918f94840b))


### Bug Fixes

* warn on duplicate mountPath and tidy review findings ([5352049](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/5352049bf6579ae764d0a3145375458eb32e129a))
