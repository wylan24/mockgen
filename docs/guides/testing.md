# Testing with mockgen

Tests that call an API need something on the other end. Hand-written fixtures go stale as the API changes, and calling a real staging API makes tests slow and flaky. mockgen gives you a server built from the spec, with data that's the same on every run.

```bash
npm install --save-dev @wylan24/mockgen
```

mockgen is an ES module. It works with Vitest, Node's built-in test runner, Playwright, and Jest when Jest runs in ESM mode.

## Unit and integration tests: `createMockServer()`

Start a server in the test process on a random free port, point your code at it, and close it afterwards:

```ts
import { createMockServer, type MockServer } from '@wylan24/mockgen';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let mock: MockServer;
let baseUrl: string;

before(async () => {
  mock = await createMockServer({ spec: './openapi.yaml', seed: 1 });
  baseUrl = await mock.listen(0); // 0 = any free port; returns e.g. http://127.0.0.1:53817
});
after(() => mock.close());

test('loads a product', async () => {
  const product = await (await fetch(`${baseUrl}/products/7`)).json();
  assert.equal(product.id, 7);
});
```

The same shape works with Vitest's `beforeAll`/`afterAll`. See the [React + Vite example's test](../../examples/react-vite/src/api.test.ts).

### Options

```ts
await createMockServer({
  spec: './openapi.yaml', // a spec file, or a folder of sample responses
  seed: 1,                // different seeds give different (still stable) data
  records: 5,             // smaller list collections make assertions easier
  delay: 0,               // add latency to every response, in ms
  locale: 'de',           // names, addresses and phone numbers in German
  stateful: true,         // POST/PUT/PATCH/DELETE change what later requests return
});
```

With `stateful: true`, call `mock.reset()` in `beforeEach` so each test starts from the same generated data. See [Stateful mode](../../README.md#stateful-mode).

## Testing error and edge cases

Send mockgen's headers from the test to get any status, or a slow response, without changing the server:

```ts
const res = await fetch(`${baseUrl}/products/7`, { headers: { 'X-Mock-Status': '404' } });
assert.equal(res.status, 404); // the spec's 404 response
```

```ts
await fetch(`${baseUrl}/products`, { headers: { 'X-Mock-Delay': '2000' } }); // test your timeout handling
```

Statuses the spec doesn't document work too: `X-Mock-Status: 503` returns a 503 with a small JSON body, `{ "error": "Service Unavailable", "message": "Service Unavailable" }`.

## Snapshot tests are safe

The same spec and seed give byte-identical responses on every OS and Node version. That's tested in mockgen's own CI on macOS, Linux and Windows. So you can snapshot what your app renders from mock data without the snapshots flapping.

Data changes when you change the seed, edit the spec, or upgrade mockgen across a release that changes generation. The [changelog](../../CHANGELOG.md) says when that happens.

## Without a server: `respond()`

To test logic that takes an API response, you don't need HTTP. `respond()` returns the exact response the server would send:

```ts
import { loadSource, respond } from '@wylan24/mockgen';

const model = await loadSource('./openapi.yaml');
const { status, body, headers } = respond(model, { method: 'GET', path: '/products', query: 'page=2&limit=10', seed: 1 });
```

## End-to-end tests: Playwright

Let Playwright start the mock API next to your app. It waits for both before running tests, and stops both afterwards:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  webServer: [
    {
      command: 'npx mockgen serve ./openapi.yaml --no-watch',
      url: 'http://127.0.0.1:4010/products', // any route in your spec
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
    },
  ],
  use: { baseURL: 'http://localhost:5173' },
});
```

Because the data is deterministic, assertions like "the first product is *Awesome Wooden Towels*" stay true. Pin the seed (`--seed 1`) so they don't change when someone edits the default.

For a test that needs an error from the API, intercept the request in the browser and add the header:

```ts
await page.route('**/products/**', (route) => route.continue({ headers: { ...route.request().headers(), 'x-mock-status': '500' } }));
```

## Next

- [Build loading, error and empty states](frontend-states.md)
- [Run it in CI](ci.md)
