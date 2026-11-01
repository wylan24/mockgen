# No spec yet? Start from sample responses

Often the API doesn't have a spec, but you do have real responses: copied from the browser's network tab, pasted from a Slack thread, or written by hand while the backend is being designed. mockgen can serve those. It infers a schema from them and generates fresh data in the same shape.

## 1. Put the responses in a folder, named after their routes

```
mocks/
├── GET.users.json            → GET /users
├── GET.users.[id].json       → GET /users/{id}
├── POST.users.json           → POST /users (201)
└── users/
    └── [id]/
        └── GET.posts.json    → GET /users/{id}/posts
```

The rules:

| File name | Route |
| --- | --- |
| `GET.users.json` | `GET /users`, status 200 |
| `GET.users.[id].json` | `GET /users/{id}`. `{id}` works in the name too |
| `users/GET.[id].json` | The same route. Folders are path segments |
| `GET.users.[id].404.json` | The 404 response for that route |
| `GET.users.[id]~alice.json` | Another sample for the same response, merged with the others |
| `POST.users.json` | `POST /users`, status 201 |
| `DELETE.users.[id].json`, empty | `DELETE /users/{id}`, 204 with no body |

Files that don't follow the pattern, and files with invalid JSON, are skipped with a warning. Dot-folders and `node_modules` inside the folder are ignored.

## 2. Serve the folder

```bash
npx @wylan24/mockgen serve ./mocks
```

Everything from [Getting started](getting-started.md) applies: stable data, consistent lists and detail routes, paging, error and delay headers, and hot reload when you add or edit a file.

The server doesn't replay your files. It generates **new** data in the same shape. A sample with `"email": "ada@example.com"` becomes an email field filled with realistic, different emails. To always return a fixed body, use a spec with an `example`.

## How the schema is inferred

All samples for one route and status are merged:

- **Optional fields.** A key missing from some samples becomes optional.
- **Nullable fields.** A key that's `null` in some samples becomes nullable.
- **Formats.** ISO dates and date-times, emails, URLs and UUIDs are detected, but only when every value matches. One email and one phone number in the same field is plain text.
- **Enums.** A few short values repeated across at least 4 samples (`status: "paid" | "pending" | "refunded"`) become an enum. Free text (`title`, `name`, `description`…), digit-only strings like zip codes, and fields with many distinct values never do.
- **Numbers.** A mix of integers and decimals is a `number`. If no sample is negative, the field gets `minimum: 0`.
- **Mixed types.** A field that's a string in one sample and a number in another becomes `anyOf`.

More samples give better inference. Two or three variants of a response (a full record, a sparse one, one with `null`s) are usually enough. Add them with `~name` files.

The [inference fixtures](../../test/fixtures/infer/README.md) show 30 cases, each sample folder with the OpenAPI it produces.

## 3. Graduate to a spec

When the shape settles, write the inferred schema out as OpenAPI 3.1 and keep editing that instead:

```bash
npx @wylan24/mockgen infer ./mocks -o openapi.yaml
npx @wylan24/mockgen serve ./openapi.yaml
```

The file is a normal spec: rename things, add descriptions, `example`s, tighter constraints and the routes you don't have samples for. Then hand it to the backend team.
