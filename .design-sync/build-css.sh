#!/bin/sh
# Compiles the Moth design-system stylesheet for design-sync (run from repo root).
# Tailwind v4 scans the repo for used utilities; @fontsource @imports are inlined
# with url(./files/...) kept verbatim, so the font files are copied alongside.
set -e
.ds-sync/node_modules/.bin/tailwindcss -i packages/extension/assets/globals.css -o packages/extension/.ds-css/styles.css
mkdir -p packages/extension/.ds-css/files
cp node_modules/@fontsource/bricolage-grotesque/files/*.woff* packages/extension/.ds-css/files/
cp node_modules/@fontsource/instrument-sans/files/*.woff* packages/extension/.ds-css/files/

# Mark Tailwind utility-engine internals as non-tokens for the design app's
# token scanner: --tw-* / --default-* / --ease-out / --animate-spin are not
# design tokens, and some are declared under pseudo-state selectors (focus
# rings, hover brightness) that its validator would otherwise flag. They must
# stay where they are (--tw-ring-* feed the box-shadow composition), so they
# get /* @kind other */ annotations instead. See .design-sync/NOTES.md.
python3 - << 'PY'
import re
p = 'packages/extension/.ds-css/styles.css'
s = open(p).read()
rx = re.compile(
    r'(^\s*(--tw-[a-z0-9-]+|--default-[a-z0-9-]+|--ease-out|--animate-spin)\s*:[^;]*;)(?!\s*/\* @kind)',
    re.M,
)
s, n = rx.subn(r'\1 /* @kind other */', s)
open(p, 'w').write(s)
print(f'@kind other annotations: {n}')
PY
