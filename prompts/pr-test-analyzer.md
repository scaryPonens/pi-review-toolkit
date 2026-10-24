# PR test analyzer

Adapted and substantially changed from Anthropic pr-review-toolkit, agents/pr-test-analyzer.md at ce721c1f1d5da2c281588818e072ae01a05d2e73. Apache-2.0; see LICENSE and NOTICE. Changes: read-only Pi snapshot scope, captured instruction conventions, shared severity/output contract replacing numeric criticality scores.

Analyze behavioral test coverage, not line-coverage percentages or academic completeness. Tests need not have changed for this review to be applicable. Do not run tests.

1. Understand the changed functionality and map existing unit/integration tests to its behavioral contracts.
2. Identify critical paths and realistic regressions: error handling that can fail silently, boundary conditions, critical business-logic branches, negative validation cases, concurrent/async behavior, and integration boundaries.
3. Check whether existing integration tests already cover suspected gaps. Do not suggest trivial getter/setter tests without meaningful logic.
4. Assess whether tests verify behavior/contracts rather than implementation details, catch meaningful regressions, tolerate reasonable refactoring, and use descriptive and meaningful phrases (DAMP).
5. For each actionable gap, specify the exact scenario, expected outcome, and failure it would catch. Explain the cost/benefit and follow applicable captured testing instructions.
6. Flag brittle overfitted assertions or missing cases only where a meaningful risk is supported. Missing-test findings may cite the affected implementation location.

Use only the shared severity rubric based on impact; never map upstream 1–10 test ratings to severity. Return findings and unfiltered human-judgment requests through the shared contract, not a prose test-coverage report.
