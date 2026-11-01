# mockgen in CI

Two jobs mockgen is good at in CI: checking that a spec is usable on every pull request, and standing in for the API while end-to-end tests run.

Pin the version in `package.json` (`npm install --save-dev @wylan24/mockgen`). Generated data only changes when you change the spec or the seed, or when you upgrade mockgen across a release whose [changelog](../../CHANGELOG.md) says generation changed.

## Check the spec on every pull request

`mockgen validate` loads the spec, generates every response, and checks each one against its schema. It exits with status 1 if the spec doesn't load (bad YAML, a broken `$ref`) or if any response can't match its schema, which usually means the schema contradicts itself:

```
✖ GET /x 200: data must match pattern "^[0-9]+$"
✖ Bad: 1 routes, 0/1 generated responses valid, 0 warnings
```

As a GitHub Actions job:

```yaml
# .github/workflows/api-spec.yml
name: API spec
on:
  pull_request:
    paths: ['openapi.yaml', 'schemas/**']
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npx @wylan24/mockgen@0.1.0-alpha.4 validate openapi.yaml
```

This catches problems a schema linter misses: an `enum` that breaks its own `pattern`, `allOf` branches that can't both hold, a `oneOf` whose branches overlap. Front-end teams find these too, usually much later.

## Run end-to-end tests against the mock API

Start mockgen in the background, wait until it answers, then run the tests:

```yaml
# .github/workflows/e2e.yml
name: E2E
on: [pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci

      - name: Start the mock API
        run: |
          npx mockgen serve openapi.yaml --no-watch --seed 1 &
          for i in $(seq 1 30); do curl -sf http://127.0.0.1:4010/products > /dev/null && exit 0; sleep 1; done
          echo "mock API didn't start" && exit 1

      - run: npm run test:e2e
        env:
          API_URL: http://127.0.0.1:4010
```

- `--no-watch` turns off hot reload, which CI doesn't need.
- `--seed 1` keeps the data your assertions rely on fixed, even if the default ever changes.
- Wait on a real route from your spec. mockgen answers 404 for paths the spec doesn't have.
- The server exits when the job ends, so there's nothing to stop.

With Playwright, `webServer` can start mockgen for you instead. See [Testing with mockgen](testing.md#end-to-end-tests-playwright).

## Unit tests

Tests that use `createMockServer()` start their own server on a random port, so they need nothing extra in CI and can run in parallel. See [Testing with mockgen](testing.md).

## Verifying the package

mockgen is published from its GitHub repository with npm provenance, a signed statement of which commit and workflow built each version. After installing, check it with:

```bash
npm audit signatures
```
