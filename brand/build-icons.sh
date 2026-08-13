#!/bin/sh
# Regenerate the extension icons from the vector masters in this directory.
#
# Two masters on purpose: icon.svg carries the antennae and the two-tone wings,
# which need 48px or more to resolve; icon-small.svg drops both and opens a notch
# between the wings so the silhouette still reads in a toolbar. Rendering one
# master at every size gives you either mush at 16px or a coarse 512.
#
# Needs a rasteriser. cairosvg is not a project dependency — icons change about
# once a rebrand, so install it ad hoc rather than carrying it in the lockfile:
#
#   python3 -m venv /tmp/icons && /tmp/icons/bin/pip install cairosvg
#   PY=/tmp/icons/bin/python sh brand/build-icons.sh
set -eu
PY="${PY:-python3}"
OUT="packages/extension/public/icon"

for size in 48 128 512; do
  "$PY" -c "import cairosvg; cairosvg.svg2png(url='brand/icon.svg', write_to='$OUT/$size.png', output_width=$size, output_height=$size)"
done
for size in 16 32; do
  "$PY" -c "import cairosvg; cairosvg.svg2png(url='brand/icon-small.svg', write_to='$OUT/$size.png', output_width=$size, output_height=$size)"
done
echo "icons written to $OUT"
