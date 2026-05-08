# Changelog

## [0.3.0](https://github.com/wridgeu/ui5-middleware-ws-mock/compare/v0.2.0...v0.3.0) (2026-05-08)


### Features

* **middleware:** log verbose on malformed PCP frames ([e316529](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/e3165296587cfc7a1019f33fe66d04d05d7da67e))
* **middleware:** log verbose on unparseable upgrade urls ([1bdaff6](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/1bdaff6c0679848b82d1781d211ba11244519b19))


### Bug Fixes

* **middleware:** hoist ws error listener so refused connections cannot crash the process ([0fd9488](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/0fd94880f19df1f44c2708a0df1f00030e9fbf8c))


### Code Refactoring

* **pcp:** drop redundant String() coercion in pcpEscape ([c2ae0d4](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/c2ae0d4faa80a2454203b7d8e586c497d9f256ff))
* **types:** extract WebSocketMode and dedupe FactoryParameters.log ([10f0edf](https://github.com/wridgeu/ui5-middleware-ws-mock/commit/10f0edf0fa6a8db2623a2ee2b87d221b73c5e300))

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
