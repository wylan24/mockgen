# mockgen

[![CI](https://github.com/wylan24/mockgen/actions/workflows/ci.yml/badge.svg)](https://github.com/wylan24/mockgen/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@wylan24/mockgen?include_prereleases)](https://www.npmjs.com/package/@wylan24/mockgen)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Turn an OpenAPI spec — or just a folder of sample JSON responses — into a running mock server with realistic, stable fake data. One command.

```bash
npx @wylan24/mockgen serve ./openapi.yaml
npx @wylan24/mockgen serve ./samples/
```

You get a server on `localhost:4010` that returns schema-valid, human-looking data, returns the same data across restarts, and can be tweaked without writing code.

> **Status:** alpha (0.x). It works and is tested against 57 real-world APIs, but options may still change before 1.0. [Feedback and bug reports](https://github.com/wylan24/mockgen/issues/new/choose) are very welcome.

## Install

Requires Node 22.19 or later. Run it without installing:

```bash
npx @wylan24/mockgen serve ./openapi.yaml
```

Or add it to a project, for scripts and tests:

```bash
npm install --save-dev @wylan24/mockgen
npx mockgen serve ./openapi.yaml
```

## Why

- **Realistic data.** Field names drive the data: `email`, `avatarUrl`, `createdAt`, `price`, `city` all look like the real thing, and a record's name, username and email match each other.
- **Deterministic.** Same spec + seed → byte-identical responses, so screenshots and tests stay stable. `GET /users/42` always returns the same user, with `id: 42`.
- **Valid.** Responses honor `enum`, `min`/`max`, `pattern`, `minLength`, `minItems`, `uniqueItems`, `oneOf`/`anyOf`/`allOf`, nullable, and use your spec's `example` values when present.
- **Zero config.** CORS on, request log in the terminal, hot reload when the spec changes.

## Usage

```bash
mockgen serve <spec|dir>             # Start a mock server (hot-reloads on change)
mockgen generate <spec|dir> [route]  # Print generated responses, e.g. "GET /users/1"
mockgen validate <spec|dir>          # Generate every response and check it against its schema
mockgen infer <dir> [-o openapi.yaml]  # Write the schema inferred from samples as OpenAPI 3.1
```

| Option | Default | |
| --- | --- | --- |
| `-p, --port` | `4010` | Port to listen on |
| `-H, --host` | `127.0.0.1` | Host to bind |
| `-s, --seed` | `1` | Seed for generated data |
| `-d, --delay` | `0` | Delay every response, e.g. `300ms` |
| `-r, --records` | `50` | Records in every list endpoint's collection |
| `-l, --locale` | `en` | Language and region for names, addresses and phone numbers, e.g. `de`, `ja`, `pt_BR` |
| `--no-watch` | | Disable hot reload |
| `-o, --out` | stdout | `infer` output file (`.yaml` or `.json`) |

### Simulating errors and latency

Per request, with a header or a query parameter:

```bash
curl -H 'X-Mock-Status: 404' localhost:4010/users/1   # the spec's 404 response
curl 'localhost:4010/users/1?__status=503'            # undocumented codes work too
curl -H 'X-Mock-Delay: 1500' localhost:4010/users     # slow this one down
```

### Other languages

Names, addresses, companies and phone numbers follow `--locale`. It takes any of the 76 locales [Faker ships](https://fakerjs.dev/guide/localization.html#available-locales), such as `de`, `fr`, `ja`, `pt_BR` or `zh_CN`:

```bash
mockgen serve ./openapi.yaml --locale de
```

The output stays deterministic per locale, and emails and usernames stay valid ASCII. Free text like `description` and `bio` is Latin placeholder text in every locale.

### Lists and pagination

Every list endpoint — a bare array of objects, or an object wrapping one (`data`, `items`, `results`, …) — is a window onto a stable collection of 50 records (`--records`):

```bash
curl 'localhost:4010/users?page=2&limit=20'   # also per_page, pageSize, offset/skip
curl 'localhost:4010/users?cursor=bzoyMA'     # any cursor mockgen handed out works
```

- Integer ids are sequential (`1…50`), so page 2 of 10 is ids 11–20, every time.
- When the spec also has `GET /users/{id}`, each list item is the same record that route returns.
- Wrapper fields are filled by name, including nested ones like `meta.pagination`: `total`, `page`, `perPage`, `totalPages`, `hasMore`, `next`/`prev` (page number, URL or cursor, and `null` on the last page).
- Responses carry `X-Total-Count` and a `Link` header with `next`/`prev`.

A page past the end is empty, even if the schema sets `minItems`.

### In tests

```ts
import { createMockServer } from '@wylan24/mockgen';

const mock = await createMockServer({ spec: './openapi.yaml', seed: 1, locale: 'en' });
const url = await mock.listen(0); // random free port
// ... run tests against url ...
await mock.close();
```

## Supported input

### OpenAPI specs

- OpenAPI 3.0 and 3.1, YAML or JSON, with local and multi-file `$ref`s (circular refs are fine).
- Swagger 2.0 is not supported; convert it with [swagger2openapi](https://github.com/Mermade/oas-kit) first.

### A folder of sample responses

No spec yet? Drop real responses into a folder, named after their route. mockgen infers a schema from them and generates fresh data in the same shape.

| File | Route |
| --- | --- |
| `GET.users.json` | `GET /users` → 200 |
| `GET.users.[id].json` or `users/GET.[id].json` | `GET /users/{id}` (folders are path segments; `{id}` works too) |
| `GET.users.[id].404.json` | the 404 response, served with `X-Mock-Status: 404` |
| `GET.users.[id]~alice.json` | another sample for the same response |
| `POST.users.json` | `POST /users` → 201 |
| `DELETE.users.[id].json` (empty file) | `DELETE /users/{id}` → 204, no body |

Every sample for a route is merged: keys missing from some samples become optional, `null` values make a field nullable, ISO dates, emails, URLs and UUIDs are detected, and a few short values repeated often (`role: admin | member | viewer`) become an enum. See [examples/samples](examples/samples).

When you're ready for a real spec, `mockgen infer ./samples -o openapi.yaml` writes the inferred schema out so you can edit it.

## Roadmap to 1.0

- [x] OpenAPI 3.0/3.1 loader with multi-file `$ref`s
- [x] Deterministic, field-name-aware data generation honoring schema constraints
- [x] Mock server: CORS, request log, status/latency simulation, hot reload
- [x] Sample-response input (folder of JSON files → inferred schema) and `mockgen infer`
- [x] List/detail consistency (`/users/{id}` returns the user from `/users`) and pagination
- [x] Spec corpus of 50+ real-world APIs in CI: every spec loads, and every generated response validates apart from documented spec bugs
- [ ] Stateful CRUD, `mock.config.ts` overrides, Docker image

## Quality: the spec corpus

mockgen is tested against 57 real-world OpenAPI specs (Stripe, GitHub, Twilio, Box, Jira, DocuSign, Plaid, Petstore variants and more from [APIs.guru](https://apis.guru)), pinned to commits in [corpus/specs.json](corpus/specs.json). Every spec must load, and every generated response is validated against its schema with Ajv.

```bash
npm run corpus:fetch        # download the specs once (~60 MB, cached in corpus/.cache)
npm run corpus              # load + generate + validate everything
npm run corpus -- stripe    # just one spec
npm run corpus:explain -- linode "GET /linode/instances" 200   # why a response fails
```

Validation follows OpenAPI semantics: 3.0 `nullable`, boolean exclusive bounds, `writeOnly` fields absent from responses, and `discriminator` choosing the `oneOf` branch.

Every spec's GET routes must also serve in under 20 ms at p95.

Some real specs contain schemas no value can satisfy (the same schema twice in a `oneOf`, `allOf: [string, null]`, contradictory enums). [corpus/baseline.json](corpus/baseline.json) lists each one with the reason. CI runs `npm run corpus -- --strict`, which fails if any spec gets worse than its baseline or any failure isn't a documented spec bug.

## Development

Requires Node 22.19+.

```bash
npm install
npm test
npm run serve:example     # builds, then serves examples/petstore.yaml
npm run smoke             # pack, install into an empty project, run the CLI and library
```

Snapshot tests in [test/snapshot.test.ts](test/snapshot.test.ts) pin generated output byte for byte, and CI runs them on macOS, Linux and Windows. If you change generation on purpose, review the diff and update with `npx vitest run -u`.

### Releasing

Bump `version` in `package.json`, commit, then push a matching tag:

```bash
git tag v0.1.0-alpha.1 && git push origin v0.1.0-alpha.1
```

The [release workflow](.github/workflows/release.yml) reruns the tests, smoke test and strict corpus gate, publishes to npm with provenance (pre-releases under the `next` dist-tag), and creates the GitHub release. It needs an `NPM_TOKEN` repository secret, or the workflow set up as a trusted publisher on npmjs.com.

## Contributing

Bug reports, specs that mockgen gets wrong, and pull requests are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and the [Code of Conduct](CODE_OF_CONDUCT.md). Ask questions in [Discussions](https://github.com/wylan24/mockgen/discussions). Report security problems privately, as described in [SECURITY.md](SECURITY.md).

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## License

[MIT](LICENSE)
