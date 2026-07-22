# Design principles

The words MUST, MUST NOT, SHOULD, and MAY are normative.

## Agent contract first

- The MCP surface MUST represent agent tasks, not upstream endpoints or product
  inventory.
- A new upstream dataset or endpoint MUST NOT automatically create a new tool.
- Similar capabilities SHOULD compose through data and schemas.
- Distinct state, permissions, failure semantics, or outcomes MAY justify a
  separate tool.
- A generic catch-all such as `execute(action, payload)` MUST NOT replace typed,
  discoverable contracts.

## Stable center, replaceable edges

- Core use cases MUST depend on local capability contracts, not Bright Data SDK,
  endpoint, or response types.
- Bright Data-specific knowledge MUST remain inside its adapter boundary.
- Dependency inversion is the architectural rule; dependency injection is the
  wiring technique.
- Dependencies MUST be supplied explicitly at one composition root.
- A DI container is out of scope unless explicit wiring becomes measurably
  unmanageable.

## Composition

- Behavior SHOULD be composed from small functions and structural contracts.
- Inheritance MUST NOT be used to model tool, dataset, or adapter families.
- Dataset differences SHOULD be represented as catalog data plus validation
  schemas.
- Shared behavior such as authentication, retries, polling, and error mapping
  MUST be implemented once at the adapter boundary.

## Adaptive disclosure

- Dataset selection MUST begin with discovery.
- Discovery results MUST include the directly executable operations, input
  schemas, limits, and examples needed for the next call.
- Execution MUST validate against that contract before calling upstream.

## Falsifiable constraints

- The V1 base profile exposes exactly six model-visible intent tools.
- The opt-in V1 browser profile adds exactly four browser tools and no other
  model-visible surface.
- Resources, tasks, or app-only implementation helpers MUST NOT become
  model-visible tools merely because a client lacks another MCP capability.
- Any further tool MAY be added only when evaluations show that an existing contract
  cannot express a materially distinct agent task without ambiguity.
- A tool SHOULD be merged when its only differences are endpoint, dataset ID,
  defaults, or upstream response shape.
- Tool count, schema size, invalid-call rate, selection accuracy, and calls per
  completed task MUST be measured before changing the surface.
