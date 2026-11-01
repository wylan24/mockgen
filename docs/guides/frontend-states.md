# Building loading, error and empty states

The happy path is the easy part of a UI. The states that take real work, like errors, slow networks, empty lists and the last page, are hard to reach against a real backend. With mockgen you can reach each one on demand, per request, without restarting anything.

## Errors

Add `X-Mock-Status` to a request, or `__status` to its query string:

```bash
curl -i -H 'X-Mock-Status: 404' localhost:4010/products/7
curl -i 'localhost:4010/products/7?__status=500'
```

- If the spec documents that status for the route, you get its response body, generated from its schema.
- Any other status works too, with a small JSON body: `{ "error": "Internal Server Error", "message": "…" }`.

In app code, it's usually easiest to put a development-only switch in your API client. The [React + Vite example](../../examples/react-vite/src/api.ts) has a "Simulate a 500 error" toggle that does exactly this.

## Loading states and slow networks

Delay one request with `X-Mock-Delay` (or `__delay`), in milliseconds:

```bash
curl -H 'X-Mock-Delay: 1500' localhost:4010/products
```

Or slow down everything while you work on spinners and skeletons:

```bash
npx @wylan24/mockgen serve ./openapi.yaml --delay 800
```

A per-request header overrides `--delay`.

## Pagination

Every list endpoint is a window onto a stable collection of 50 records (change it with `--records`). Integer ids run from 1 to 50, so page 2 of 10 is always ids 11 to 20.

mockgen understands the common paging styles:

| Style | Query parameters |
| --- | --- |
| Page number | `page`, with `limit`, `per_page`, `perPage`, `page_size`, `pageSize`, `size` or `first` |
| Offset | `offset`, `skip` or `start`, with a limit |
| Cursor | `cursor`, `after`, `starting_after`, `page_token` or `pageToken`, using any cursor mockgen gave you |

Responses carry `X-Total-Count` and a `Link` header with `next` and `prev`. When the list is wrapped in an object (`{ data: [...], meta: {...} }`), wrapper fields are filled in by name: `total`, `page`, `perPage`, `totalPages`, `hasMore`, `next` and `prev` (a page number, URL or cursor, and `null` on the last page). That includes nested ones like `meta.pagination`.

To test infinite scroll, page to the end. With `limit=20`, the pages hold 20, 20 and 10 records. On the last page there's no `next` link, and in a wrapped list `hasMore` is `false` and `next` is `null`.

## Empty states

A page past the end is an empty list, even if the schema sets `minItems`:

```bash
curl 'localhost:4010/products?page=99'
```

```json
[]
```

For an empty first page, start the server with fewer records, or with none:

```bash
npx @wylan24/mockgen serve ./openapi.yaml --records 0
```

## Long and international text

UIs often break on names longer than "John Smith". Run with another locale to see names, addresses and phone numbers in that language:

```bash
npx @wylan24/mockgen serve ./openapi.yaml --locale de   # long compound names
npx @wylan24/mockgen serve ./openapi.yaml --locale ja   # non-Latin scripts
```

Emails and usernames stay valid ASCII in every locale. `--locale` takes any of the 76 locales [Faker ships](https://fakerjs.dev/guide/localization.html#available-locales).

## Calling the mock from a browser or a phone

- **Browser apps.** CORS is open (`Access-Control-Allow-Origin: *`), so you can call `http://127.0.0.1:4010` directly, or proxy to it from your dev server. See the [React + Vite](../../examples/react-vite) and [Next.js](../../examples/nextjs) examples.
- **Phones and emulators.** `localhost` on the device isn't your computer. Use `10.0.2.2` from the Android emulator, or start mockgen with `--host 0.0.0.0` and use your computer's LAN address from a physical phone. The [React Native example](../../examples/react-native) covers each case.

## Next

- [Use the same tricks in automated tests](testing.md)
