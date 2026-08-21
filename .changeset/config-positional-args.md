---
'@shieldedtech/moth-wallet': patch
---

Generate the oclif manifest, without which no command could take a positional argument.

`moth config` was unusable — every invocation failed — and the cause turned out to
affect six commands, not one. With `topicSeparator: " "`, oclif decides where a
command id ends by walking argv and stopping when the id it has matched so far
names a command that declares positional arguments. It answers that from its
command cache, which is populated from `oclif.manifest.json`. No manifest was ever
generated, so that check was false for every command and oclif kept consuming
tokens as command-path segments:

```
moth mint 1              -> Error: command mint 1 not found
moth state <address>     -> Error: command state <address> not found
moth config get prover   -> Error: command config get prover not found
```

`call`, `config`, `deploy`, `mint`, `state` and `transfer` all declare positional
args, all read them, and all had them documented in the README. None worked.
Nested commands were unaffected, which is why this went unnoticed: `wallet remove
<name>` matches a two-segment id first and the argument survives.

`yarn build` now runs `oclif manifest` after `tsc`, and the manifest ships in
`files` — an installed CLI has the same broken resolution without it. It is
gitignored, because a committed copy would go stale against the built commands.
A test asserts it exists and records args for every command that declares them.

`config` also declared an optional positional (`action`) ahead of a required one
(`key`), which oclif rejects outright, so that command failed at spec validation
even before resolution. `action` is now required, which changes no working
behaviour because nothing worked.
