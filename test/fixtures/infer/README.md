# Inference fixtures

Each folder holds a `samples/` folder and the OpenAPI that `mockgen infer` should write for it (`expected.openapi.yaml`). [`infer-fixtures.test.ts`](../../infer-fixtures.test.ts) checks three things for each one:

1. The inferred OpenAPI matches `expected.openapi.yaml`, and any warnings match `expected.warnings.json`.
2. Every sample validates against its inferred schema. Inference must never be stricter than the data.
3. The expected file loads back in as a spec with the same routes, and responses generated from it validate.

| Fixture | Covers |
|---|---|
| 01-primitive-types | string, integer, number, boolean, and a field that is only ever `null` |
| 02-optional-fields | a key missing from some samples becomes optional |
| 03-nullable-fields | `null` in some samples gives `type: [string, null]`, and keeps a detected format |
| 04-nullable-object | an object that is sometimes `null` |
| 05-string-formats | `date-time` (with offsets and fractions), `date`, `uuid`, `email`, `uri` |
| 06-mixed-formats | an email and a phone number in one field: no format; a URL and a relative path: no format |
| 07-impossible-dates | `2024-02-30` is not a date, `2024-02-29` is, and a space-separated timestamp is not `date-time` |
| 08-enum-detection | a few short values repeated across many samples become an enum |
| 09-free-text-not-enum | a repeated `title` stays free text, while a repeated `category` becomes an enum |
| 10-too-few-for-enum | fewer than 4 samples is not enough evidence for an enum |
| 11-numeric-strings | digit-only strings (zip codes) never become an enum |
| 12-many-distinct-values | unique values (SKUs), and more than 8 distinct values: no enum |
| 13-integer-and-float | integers and floats in one field widen to `number` |
| 14-negative-numbers | any negative value drops `minimum: 0`; names like `lat` and `balance` never get it (see also 15) |
| 15-nested-objects | objects inside objects, three levels deep |
| 16-top-level-array | a list response: item keys missing from some items are optional |
| 17-empty-arrays | an always-empty array (`items: {}`), and one that is empty in some samples |
| 18-array-of-primitives | arrays of strings, numbers, booleans, and a top-level array of strings |
| 19-mixed-types | a field that is a string in one sample and a number in another (`anyOf`) |
| 20-nested-arrays | arrays of arrays, of numbers and of objects |
| 21-pagination-wrapper | `data` + `meta` + `links` with nullable next/prev URLs, merged across pages |
| 22-nested-folders | folders as path segments: `users/GET.[id].json`, `users/[id]/GET.posts.json` |
| 23-brace-params | `{param}` in file names, several per path |
| 24-tilde-variants | several `~name` samples for one response, merged |
| 25-status-codes | 404, 422 and 500 samples; POST defaults to 201; 422 variants merged |
| 26-empty-bodies | empty files become 204 responses with no body |
| 27-ignored-files | misnamed files and invalid JSON are skipped with a warning; non-JSON files and dot-folders silently |
| 28-unusual-keys | keys with spaces, dots, accents, `$ref`, `type`, and the empty string |
| 29-github-issue | a realistic GitHub issue: nullable objects, timestamps, avatar URLs, labels |
| 30-stripe-charge-list | a realistic Stripe list: `object` discriminator values, Unix timestamps, sparse `metadata` |

## Adding or changing a fixture

Add a folder with a `samples/` folder, then run:

```bash
npx vitest run test/infer-fixtures.test.ts -u
```

**Review the generated `expected.openapi.yaml` by hand before committing.** A fixture is only useful if its expected file is what inference *should* produce, not just what it produces today. The same command updates the expected files when inference changes on purpose; review that diff too.
