# React + Vite example

A small task list built against [`api/openapi.yaml`](api/openapi.yaml) before any backend exists. mockgen serves the spec, and Vite's dev proxy forwards `/api` to it, so the app code is the same code that will later talk to the real API.

## Run it

```bash
npm install
npm run mock    # terminal 1: mock server on http://127.0.0.1:4010
npm run dev     # terminal 2: the app on http://localhost:5173
```

Try:

- **Paging.** The list is a stable 50-record collection, 5 per page. Reload and you get the same tasks.
- **Detail.** Click a task: `GET /tasks/{id}` returns the same record the list showed.
- **Error and loading states.** The two checkboxes add `X-Mock-Status: 500` and `X-Mock-Delay: 1500` to requests, so you can build those states without breaking anything.

## Test it

```bash
npm test
```

[`src/api.test.ts`](src/api.test.ts) starts mockgen in-process with `createMockServer()` on a random port, and tests the API client against it. There's no network and there are no fixtures to keep up to date.

## Files

| File | What it shows |
| --- | --- |
| [`vite.config.ts`](vite.config.ts) | Proxying `/api` to the mock server in development |
| [`src/api.ts`](src/api.ts) | A plain `fetch` client, plus the optional mockgen headers |
| [`src/App.tsx`](src/App.tsx) | Paging, detail and error/loading toggles |
| [`src/api.test.ts`](src/api.test.ts) | Testing against `createMockServer()` |

When the real API is ready, change the proxy `target` in `vite.config.ts`. Nothing else changes.
