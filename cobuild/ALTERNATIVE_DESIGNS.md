# Alternative Designs

## Looping Cobuild

This is the non-default `cobuild` design for situations where the first critique and rebuild pass still leaves major disagreement.

### When To Use It

Use this variant only when the fixed default flow stops with substantial unresolved objections and the parent believes additional build work is likely to produce a better result.

### Loop Shape

The looping variant extends the default flow like this:

`setup -> build -> critique -> rebuild -> critique -> rebuild -> ... -> decide -> approve -> apply`

Rules:

- Require at least two critique/rebuild loops before the run may stop for agreement.
- Keep the same child sessions and worktrees for the full run.
- After the second loop, continue only while the latest critique introduces materially new objections or materially better synthesis opportunities.
- Stop looping when:
  - the objections have stabilized, or
  - the parent concludes another rebuild round is unlikely to improve the outcome materially.

### Why It Is Not The Default

This variant is more flexible, but it is also more likely to inherit the same over-iteration and under-iteration problems that motivated `cobuild` in the first place. The default design stays fixed and predictable on purpose.
