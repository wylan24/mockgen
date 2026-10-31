# Contributing to mockgen

Thanks for helping. Bug reports, spec files that mockgen gets wrong, docs fixes and code are all welcome.

## Reporting a bug

[Open an issue](https://github.com/wylan24/mockgen/issues/new/choose). The most useful reports include:

- the command you ran and what you expected,
- the smallest spec or sample folder that shows the problem (trim it down if you can),
- your mockgen version (`npx @wylan24/mockgen --version`), Node version and OS.

If a public API's spec makes mockgen fail, a link to the spec is enough.

Questions and ideas are better in [Discussions](https://github.com/wylan24/mockgen/discussions). Security problems go through the [security policy](SECURITY.md), not public issues.

## Setting up

You need Node 22.19 or later.

```bash
git clone https://github.com/wylan24/mockgen
cd mockgen
npm install
npm test
npm run serve:example   # builds, then serves examples/petstore.yaml
```

## Making a change

1. Fork the repo and create a branch.
2. Make the change, with a test that fails without it. Tests live in `test/` and run with [Vitest](https://vitest.dev).
3. Run the checks CI runs:

   ```bash
   npm run typecheck
   npm test
   npm run smoke          # packs the package and runs it from an empty project
   ```

4. If you changed data generation or spec loading, run the real-world spec corpus too:

   ```bash
   npm run corpus:fetch   # once, about 60 MB
   npm run corpus -- --strict
   ```

5. Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) if users will notice the change.
6. Open a pull request. CI runs everything on macOS, Linux and Windows with Node 22 and 24.

## Things to know

- **Output must be deterministic.** The same spec and seed must give byte-identical output on every OS and Node version. Snapshot tests in `test/snapshot.test.ts` enforce this. If you change generation on purpose, update the snapshots with `npx vitest run -u` and say so in the pull request.
- **Inference fixtures** in `test/fixtures/infer` pin what `mockgen infer` produces. See [their README](test/fixtures/infer/README.md) before adding or changing one.
- **Generated responses must validate.** The corpus checks every response against its schema. When a real spec is itself unsatisfiable, record it in `corpus/baseline.json` with the reason instead of working around it.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By taking part you agree to it.
