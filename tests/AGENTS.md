# AGENTS.md — `tests/`

## Purpose

Shell-based smoke tests for the project's runtime build pipeline (Python runtime bundling, database runtime bundling, container builds). These tests are NOT part of the Next.js app — they verify the deployment artifact shape.

## Ownership

- `python-runtime-build.sh` — tests that the Python runtime build script (located at `../.zscripts/python-runtime-build.sh`, NOT in this repo) correctly bundles Python scripts and excludes `.venv/` from the output.
- `python-runtime-container.sh` — tests the containerized Python runtime build.
- `database-runtime-build.sh` — tests that the database runtime build correctly bundles schema + seed data.

## Local Contracts

### What these tests are
- Each `.sh` file is a self-contained Bash test that:
  1. Creates a temp directory (`mktemp -d`).
  2. Sets up a minimal fixture project structure.
  3. Invokes the corresponding build script from `../.zscripts/`.
  4. Asserts the output shape with `test -f` / `test ! -e`.
  5. Cleans up the temp directory on exit (`trap 'rm -rf "$TEST_ROOT"' EXIT`).
- They use `set -euo pipefail` — fail fast on any error.

### What these tests are NOT
- They are NOT unit tests for the Next.js app. There is no Jest / Vitest / Playwright test runner configured for the app code.
- They are NOT run by `bun run lint` or `bun run build`. They must be invoked manually.
- They depend on `../.zscripts/` which is OUTSIDE this repo — these tests will fail if run in a context where `.zscripts/` is not present (e.g. a fresh clone). This is a known limitation.

### Running
```bash
bash tests/python-runtime-build.sh
bash tests/python-runtime-container.sh
bash tests/database-runtime-build.sh
```
Each prints a "passed" message on success and exits non-zero on failure.

## Work Guidance

- These tests are low-priority — they exist to verify a deployment pipeline that is not the primary deliverable of this repo.
- Do not add new tests here unless they verify the same deployment pipeline.
- For app-level tests (component tests, integration tests), set up a proper test runner (Vitest is recommended for Next.js + Bun) in a new `__tests__/` folder at the repo root, not here.

## Verification

- `bash tests/python-runtime-build.sh` — should print "python runtime build tests passed".
- `bash tests/database-runtime-build.sh` — should print the corresponding pass message.
- These tests are NOT part of CI (no CI is configured).

## Child DOX Index

No child `AGENTS.md` files. This folder is flat.
