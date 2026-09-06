# Migration Rules

This repository is undergoing a Python → Node.js/TypeScript backend migration.

Priorities:

1. Preserve observable behavior.
2. Preserve the existing Next.js frontend unless compatibility requires changes.
3. Prefer incremental migration over rewrites.
4. Do not redesign the database without necessity.
5. Do not delete Python implementations until the replacement is verified.
6. Never claim completion without running tests/build/typecheck.
7. Fix root causes rather than disabling validation or weakening tests.
8. Avoid unrelated refactoring.
9. Prefer simple Node.js architecture over unnecessary abstractions.
10. Production runtime must eventually contain no Python dependency.
