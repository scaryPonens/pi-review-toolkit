# Agent guidelines

## Project

`pi-review-toolkit` is a TypeScript ESM package for read-only parallel snapshot reviews for Pi. Requires Node.js >=22.19.

## Layout

- `src/`: implementation; `extension.ts` is the extension entry point.
- `test/`: tests and helpers.
- `docs/`: design documentation.
- `prompts/`: review prompts.
- `dist/`: generated build output; edit source files instead.

## Commands

- `npm install`: install dependencies.
- `npm run check`: type-check without emitting files.
- `npm test`: build and run the test suite.
- `npm run build`: compile TypeScript.

## Working conventions

- Keep changes focused and follow existing TypeScript and ESM conventions.
- Preserve read-only review behavior and snapshot isolation.
- Add or update tests when changing behavior.
- Run `npm run check` and `npm test` before handing off code changes; report any checks that could not run.
- Update documentation when changing user-facing behavior.
- Never commit secrets or unrelated changes.
