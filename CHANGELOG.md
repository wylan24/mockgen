# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-alpha.1] - 2026-10-31

First public alpha.

### Added

- `mockgen serve`, `generate`, `validate` and `infer` commands, and `createMockServer()` for test suites.
- OpenAPI 3.0 and 3.1 input: YAML or JSON, specs split across files, circular `$ref`s.
- Sample-folder input: a folder of real JSON responses routed by file name, with the schema inferred from them. `mockgen infer` writes it out as OpenAPI 3.1.
- Realistic, field-name-aware data that honors enums, patterns, min/max limits, `oneOf`/`anyOf`/`allOf`, nullable fields, discriminators and spec examples.
- Deterministic output: the same seed gives byte-identical responses on every OS and Node version.
- Stable 50-record collections behind list endpoints, with page/limit, offset and cursor paging, `X-Total-Count` and `Link` headers. List items match their detail routes.
- CORS by default, a request log, `X-Mock-Status` and `X-Mock-Delay` for errors and latency, and hot reload that keeps serving the last good version when the spec breaks.
- `--locale` (and a `locale` option) for names, addresses and phone numbers in any of Faker's 76 locales.

### Fixed

- Hot reload kept watching after a failed reload saved with write-then-rename, as many editors do (Linux and macOS).
- Hot reload is armed before the server announces it is ready.
- Sample folders inside a dot-folder (such as `.mocks/`) now load.
- Load errors show paths relative to the working directory, and a busy port gets a clear message.
- Lower memory use: only Faker's English locale is loaded.

[Unreleased]: https://github.com/wylan24/mockgen/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/wylan24/mockgen/releases/tag/v0.1.0-alpha.1
