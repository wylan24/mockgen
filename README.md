# mockgen

Turn an OpenAPI spec — or just a folder of sample JSON responses — into a running mock server with realistic, stable fake data. One command.

```bash
npx @wylan24/mockgen serve ./openapi.yaml
npx @wylan24/mockgen serve ./samples/
```

You get a server on `localhost:4010` that returns schema-valid, human-looking data, returns the same data across restarts, and can be tweaked without writing code.

> **Status:** early development (0.x). Not yet published to npm — run it from source for now (see [Development](#development)).

## Why

- **Realistic data.** Field names drive the data: `email`, `avatarUrl`, `createdAt`, `price`, `city` all look like the real thing, and a record's name, username and email match each other.
- **Deterministic.** Same spec + seed → byte-identical responses, so screenshots and tests stay stable. `GET /users/42` always returns the same user, with `id: 42`.
- **Valid.** Responses honor `enum`, `min`/`max`, `pattern`, `minLength`, `minItems`, `uniqueItems`, `oneOf`/`anyOf`/`allOf`, nullable, and use your spec's `example` values when present.
- **Zero config.** CORS on, request log in the terminal, hot reload when the spec changes.

## Usage

```bash
mockgen serve <spec|dir>             # Start a mock server (hot-reloads on change)
mockgen generate <spec|dir> [route]  # Print generated responses, e.g. "GET /users/1"
mockgen validate <spec|dir>          # Load the input and generate every response
mockgen infer <dir> [-o openapi.yaml]  # Write the schema inferred from samples as OpenAPI 3.1
```

| Option | Default | |
| --- | --- | --- |
| `-p, --port` | `4010` | Port to listen on |
| `-H, --host` | `127.0.0.1` | Host to bind |
| `-s, --seed` | `1` | Seed for generated data |
| `-d, --delay` | `0` | Delay every response, e.g. `300ms` |
| `-r, --records` | `50` | Records in every list endpoint's collection |
| `--no-watch` | | Disable hot reload |
| `-o, --out` | stdout | `infer` output file (`.yaml` or `.json`) |

### Simulating errors and latency

Per request, with a header or a query parameter:

```bash
curl -H 'X-Mock-Status: 404' localhost:4010/users/1   # the spec's 404 response
curl 'localhost:4010/users/1?__status=503'            # undocumented codes work too
curl -H 'X-Mock-Delay: 1500' localhost:4010/users     # slow this one down
```

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

const mock = await createMockServer({ spec: './openapi.yaml', seed: 1 });
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
- [ ] Spec corpus of 50+ real-world APIs in CI
- [ ] Stateful CRUD, `mock.config.ts` overrides, Docker image

## Development

Requires Node 22.19+.

```bash
npm install
npm test
npm run serve:example     # builds, then serves examples/petstore.yaml
```

## License

[MIT](LICENSE)
