# mockgen

Turn an OpenAPI spec into a running mock server with realistic, stable fake data — one command.

```bash
npx @wylan24/mockgen serve ./openapi.yaml
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
mockgen serve <spec>                 # Start a mock server (hot-reloads on change)
mockgen generate <spec> [route]      # Print generated responses, e.g. "GET /users/1"
mockgen validate <spec>              # Load the spec and generate every response
```

| Option | Default | |
| --- | --- | --- |
| `-p, --port` | `4010` | Port to listen on |
| `-H, --host` | `127.0.0.1` | Host to bind |
| `-s, --seed` | `1` | Seed for generated data |
| `-d, --delay` | `0` | Delay every response, e.g. `300ms` |
| `--no-watch` | | Disable hot reload |

### Simulating errors and latency

Per request, with a header or a query parameter:

```bash
curl -H 'X-Mock-Status: 404' localhost:4010/users/1   # the spec's 404 response
curl 'localhost:4010/users/1?__status=503'            # undocumented codes work too
curl -H 'X-Mock-Delay: 1500' localhost:4010/users     # slow this one down
```

### In tests

```ts
import { createMockServer } from '@wylan24/mockgen';

const mock = await createMockServer({ spec: './openapi.yaml', seed: 1 });
const url = await mock.listen(0); // random free port
// ... run tests against url ...
await mock.close();
```

## Supported input

- OpenAPI 3.0 and 3.1, YAML or JSON, with local and multi-file `$ref`s (circular refs are fine).
- Swagger 2.0 is not supported; convert it with [swagger2openapi](https://github.com/Mermade/oas-kit) first.

## Roadmap to 1.0

- [x] OpenAPI 3.0/3.1 loader with multi-file `$ref`s
- [x] Deterministic, field-name-aware data generation honoring schema constraints
- [x] Mock server: CORS, request log, status/latency simulation, hot reload
- [ ] Sample-response input (folder of JSON files → inferred schema) and `mockgen infer`
- [ ] List/detail consistency (`/users/{id}` returns the user from `/users`) and pagination
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
