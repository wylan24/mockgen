# Getting started

From an OpenAPI spec to a running mock API in about five minutes. You need Node 22.19 or later.

## 1. Have a spec

Any OpenAPI 3.0 or 3.1 file works, YAML or JSON, including specs split across files with `$ref`. If you don't have one, save this as `openapi.yaml`:

```yaml
openapi: 3.1.0
info: { title: Shop, version: 1.0.0 }
paths:
  /products:
    get:
      responses:
        '200':
          description: Products
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/Product' }
  /products/{id}:
    get:
      parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
      responses:
        '200':
          description: One product
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Product' }
        '404':
          description: Not found
components:
  schemas:
    Product:
      type: object
      required: [id, name, price]
      properties:
        id: { type: integer }
        name: { type: string }
        price: { type: number, minimum: 0 }
        inStock: { type: boolean }
        imageUrl: { type: string, format: uri }
```

No spec at all? Start from [sample responses](from-samples.md) instead.

## 2. Start the mock server

```bash
npx @wylan24/mockgen serve ./openapi.yaml
```

mockgen prints every route and listens on `http://127.0.0.1:4010`:

```bash
curl localhost:4010/products/7
```

```json
{
  "id": 7,
  "name": "Awesome Wooden Towels",
  "price": 545.49,
  "inStock": true,
  "imageUrl": "https://picsum.photos/seed/ikcqXRaGEj/640/480"
}
```

You get exactly this response too, on any machine, because the data is seeded. A few things always hold:

- **The data fits each field.** `name` on a product looks like a product, `price` is a price, and `email`, `avatarUrl` or `createdAt` look like the real thing. A person's name, username and email match each other.
- **It's valid.** Every response matches its schema: types, enums, `minimum`/`maximum`, `pattern`, required fields, `oneOf`, nullable fields. If the spec has an `example`, mockgen uses it.
- **It's stable.** Run the command again, or restart tomorrow, and `/products/7` is the same product with `id: 7`.
- **Lists are consistent.** `GET /products` is a stable collection of 50 products, and each item is the same record `GET /products/{id}` returns.

## 3. Point your app at it

Use `http://127.0.0.1:4010` as your API's base URL in development. CORS is on, so browser apps can call it directly. Or proxy to it from your dev server, as the [React + Vite example](../../examples/react-vite) does.

The server reloads when the spec changes. If a change breaks the spec, it keeps serving the last version that worked and prints the error.

## 4. Useful options

```bash
npx @wylan24/mockgen serve ./openapi.yaml --port 8080   # another port
npx @wylan24/mockgen serve ./openapi.yaml --seed 2      # different (but still stable) data
npx @wylan24/mockgen serve ./openapi.yaml --locale de   # German names, addresses, phone numbers
npx @wylan24/mockgen serve ./openapi.yaml --delay 300   # every response takes 300 ms
```

Without starting a server:

```bash
npx @wylan24/mockgen generate ./openapi.yaml "GET /products/7"   # print one response
npx @wylan24/mockgen validate ./openapi.yaml                     # generate every response and check it against its schema
```

`validate` is also a quick spec check: a response that fails its own schema usually means the schema contradicts itself (say, an `enum` whose values break its own `pattern`).

## Install it in a project

For scripts and tests, add it as a dev dependency:

```bash
npm install --save-dev @wylan24/mockgen
```

```json
{
  "scripts": {
    "mock": "mockgen serve ./openapi.yaml"
  }
}
```

## Next

- [Build loading, error and empty states](frontend-states.md) with per-request headers
- [Use mockgen in tests](testing.md)
- [Run it in CI](ci.md)
