# Security policy

## Supported versions

mockgen is in alpha. Security fixes go into the latest release only.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub instead: go to the [Security tab](https://github.com/wylan24/mockgen/security) and choose **Report a vulnerability**.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get an acknowledgement within 7 days. Once a fix is released, you'll be credited in the advisory unless you'd rather not be.

## Scope

mockgen is a development tool. It is meant to run on your own machine or in CI, serving fake data, and it binds to `127.0.0.1` by default. Reports are most useful when they involve:

- reading or writing files outside the spec's folder while loading a spec or sample folder,
- code execution from a crafted spec, sample file or request,
- the server being reachable or exploitable in its default configuration.

Running `mockgen serve --host 0.0.0.0` on an untrusted network exposes a server that answers anyone. That is expected behaviour, not a vulnerability.
