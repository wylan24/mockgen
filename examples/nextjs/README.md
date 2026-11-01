# Next.js example

A task list rendered by server components, fetching from [`api/openapi.yaml`](api/openapi.yaml) through mockgen. The API's base URL comes from `API_URL`, so the same code talks to the real API once it exists.

## Run it

```bash
npm install
npm run mock    # terminal 1: mock server on http://127.0.0.1:4010
npm run dev     # terminal 2: the app on http://localhost:3000
```

- `/` lists tasks, 10 per page (`/?page=2`, …), from a stable 50-record collection.
- `/tasks/12` shows one task: the same record the list showed.
- `/tasks/abc` is a 404.

## Pointing at the real API

```bash
API_URL=https://api.example.com npm run dev
```

The default, `http://127.0.0.1:4010`, is set in [`app/api.ts`](app/api.ts). Server components fetch from the Node process, so the mock server doesn't need CORS here, and the browser never talks to it directly.

## Files

| File | What it shows |
| --- | --- |
| [`app/api.ts`](app/api.ts) | A server-side client with a configurable `API_URL` and no caching |
| [`app/page.tsx`](app/page.tsx) | A paged list rendered on the server |
| [`app/tasks/[id]/page.tsx`](app/tasks/%5Bid%5D/page.tsx) | A detail page, with `notFound()` for a bad id or a 404 from the API |

To work on error pages, temporarily send `X-Mock-Status: 500` (or `404`) from `get()` in `app/api.ts`. mockgen then answers every request with that status.
