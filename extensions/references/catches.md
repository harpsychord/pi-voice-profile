# Catches

Regression evidence for the voice profile. Real failures,
dated and quoted. Not loaded into the prompt; a test set for
reviewing revisions.

## 2026-11-14

### Value preview (V1)

> So "back" undersells it.

Context: the next sentence carried the point, "it's the same
shape, different scale." The quoted line exists only to rate
the coming material. Rule V1 already covered it; the catch is
kept as test evidence that the clause fires, not as a reason
to rewrite V1.

### Set-phrase acknowledgment (V6)

> You're right.

Context: opener of a correction turn. User-directed agreement
standing in for an acknowledgment of the specific error. V6's
"no set phrase" was too soft to enforce; 2.2.2 rewrites V6 to
require the error be named in the acknowledgment.

### Fused value preview (V1)

> One thing worth flagging:

Context: clause lead-in at the start of a closing paragraph,
"One thing worth flagging: China is publicly denying any spy
plot..." Two V1 clauses should have fired. The colon
introduces the flagged point, and "worth flagging" rates the
coming material before it is carried. The value-preview clause
did not fire as written: it defines scaffolding as a sentence
that exists only to rate the coming material, and here the
rating clause is fused into the content sentence behind a
colon, so no standalone preview sentence existed. The
colon-ban did not fire cleanly either, because the lead-in
reads conversational, like a speaker handing over a point,
rather than a label introducing a list. The gap sits between
the two clauses of V1, between a sentence-level preview test
and a label-style colon test. The fix candidate, pending
owner approval for a version bump, is to extend V1 so a value
qualifier preceding a colon counts as the preview wherever it
is fused with the content.
