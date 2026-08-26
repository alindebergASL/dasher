# A5 decided: the disclaimer stands, and the titles are allowed

Status: Decided by the owner, 2026-08-26
Decides: [Requirements Amendment 01](2026-08-12-requirements-amendment-01.md) A5
Relates to: [Forward plan](../roadmap/2026-08-13-forward-plan.md) steps 5 and 6

## The question

A5 recorded a live contradiction and deliberately left it open. The planner,
asked for a flood watch, produces a dashboard titled "Sacramento Flood Watch"
addressed to "Emergency management leads", while `PRODUCT_REQUIREMENTS.md:247`
disclaims emergency dispatch and safety-critical flood warning. Both stood
without a rule reconciling them, and the forward plan named this as needing a
product answer before anyone outside the owner can reach the product.

A5 listed three options: narrow the first vertical away from emergency framing;
constrain the audiences and titles a planner may emit; or accept the positioning
deliberately.

## The decision

The third. The disclaimer stands as the boundary, and the planner may continue to
emit emergency-shaped titles and audiences. No composition-contract constraint is
added, and the free-text gate is not extended to refuse them.

## What this closes, and what it does not

It closes the blocker. Steps 5 and 6 — sign-in and a deployed environment — were
gated on A5 having _an_ answer, and they now have one.

It does not satisfy the constraint A5 itself proposed. That text reads:

> Dasher must not present itself, by title, audience, framing, or alert language,
> as an authority for a use it disclaims. [...] This is enforced in the
> composition contract rather than by a disclaimer, because a disclaimer does not
> constrain generated output.

The decision selects an option A5 offered while declining the constraint A5 said
any resolution must meet. That is the owner's call to make — Amendment 01 is
Proposed and does not govern — but the disagreement is recorded here rather than
resolved by quietly rewriting A5, because the reason the constraint was written
does not go away by being declined: a disclaimer in the product requirements is
not read by the planner, and nothing in the pipeline consults it.

So the residual risk is stated plainly and left standing: a reader can be shown a
page titled as an emergency warning, addressed to emergency responders, whose
only qualification is a notice elsewhere. Nothing in the code prevents that
today, and after this decision nothing is scheduled to.

A5's own third option names the mitigation this decision does not include —
"accept the positioning deliberately **after legal review**". That review has not
happened. It is not a blocker to the engineering steps this unblocks, and it is
a blocker to a real pilot user reaching the product with real data, which is the
same list of Gate 7 entry requirements the permitted-data-class and liability
questions already sit on.

## What would reopen this

A pilot organization in an emergency-management, clinical, or safety-adjacent
vertical. The decision is defensible for a finance vertical where the disclaimed
use is remote from the product's actual subject; it is a different decision when
the disclaimed use is the one the customer is buying it for.
