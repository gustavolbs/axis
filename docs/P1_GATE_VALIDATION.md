# P1 Gate Validation Record

Date: 2026-09-03
PR: #88

This file records validation facts that are useful when interpreting the P1 gate. The authoritative CI result for acceptance item 12 is the GitHub Actions status on the current PR head; a source commit cannot self-attest the result of CI that only runs after that commit exists.

## Initial PR validation

CI run #894 executed against the first gate head.

- Windows: PASS — full `npm run check`, including release metadata validation, TypeScript/app build, complete test suite, and Windows worker guards.
- Linux: PASS — version gate, `npm run release:validate`, build, and complete test suite.
- macOS: FAIL during `capture-api-key-lifecycle-visual.mjs` after desktop build and shell contracts had passed.

The macOS failure exposed a stale visual-smoke assumption rather than a reason to weaken runtime security: the fixture configured an OpenAI API Key connection to `http://127.0.0.1`, then expected the cloud provider health probe to reach that loopback server. The merged runtime network policy correctly rejects cloud-provider insecure/loopback endpoints before sending a request.

## Gate hardening

The visual smoke now validates the real security contract:

- the unsafe local OpenAI endpoint is rejected with the runtime network-policy decision;
- zero provider request reaches the loopback fixture;
- API-key rotation is verified through the shared macOS Keychain item;
- rotating one Connection does not change its sibling credential;
- edit, disable/enable, removal, Company ownership, and sibling isolation continue to be exercised through the real Electron UI.

Provider-success behavior itself remains covered by the API-key lifecycle test using a public-HTTPS-shaped endpoint and an injected fetch implementation. The visual smoke does not create a test-only bypass of production network policy.

## Final criterion

Acceptance item 12 is PASS only when PR #88 reports green CI on its current head. A green CI result does not change the overall `P1 Gate Result`: P1 remains FAIL while the documented P0/P1 product blockers remain.