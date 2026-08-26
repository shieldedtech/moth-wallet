---
'@shieldedtech/moth-wallet': patch
---

Make `moth config` usable, and add smoke coverage for the class of bug it was.

`config` declared an optional positional argument (`action`) ahead of a required
one (`key`). @oclif/core rejects that outright — with `action` absent, a single
value is ambiguous between an action and a key — so every invocation failed at
spec validation and the command body never ran. `action` is now required, which
changes no working behaviour because nothing worked.

Nothing caught this because no test invoked the command. Two probes now cover the
class:

- **Positional order, checked statically from source.** This is the one that
  bites: reverting the fix produces `config: required "key" follows optional
  "action"`.
- **A `--help` sweep over all 35 commands**, which catches a broken flag
  definition, a bad example, or an import that throws on load.

Worth recording why it takes two. `--help` does not validate positional-argument
order: with the bad spec in place, `moth config --help` prints help perfectly
happily while bare `moth config` reports "Invalid argument spec". So the help
sweep would not have caught the bug that prompted it, and the order rule has to be
checked separately. Invoking every command bare would catch it, but would also
run them.
