"""Searches files for a recovery phrase and the seed derived from it, and exits 1 if any holds
them. Prints only where and what kind of match, never the matched text.

    python3 -I scripts/phrase-scan.py PHRASE_FILE PATH...   (a PATH may be a directory)
"""
import hashlib, os, re, sys

phrase_file, *roots = sys.argv[1:]
words = open(phrase_file).read().split()
# The wallet's seed is the BIP-39 seed of the phrase, with no passphrase.
seed = hashlib.pbkdf2_hmac('sha512', ' '.join(words).encode(), b'mnemonic', 2048).hex()

sep = rb'[^a-z]{1,8}'
patterns = {
    'full phrase': re.compile(sep.join(re.escape(w.encode()) for w in words)),
    '3 consecutive words': re.compile(b'|'.join(
        sep.join(re.escape(w.encode()) for w in words[i:i + 3]) for i in range(len(words) - 2))),
    'seed hex': re.compile(b'(' + seed[:32].encode() + b'|' + seed[64:96].encode() + b')'),
}

hits, scanned = [], 0
for root in roots:
    paths = [root] if os.path.isfile(root) else [os.path.join(d, f) for d, _, fs in os.walk(root) for f in fs]
    for path in paths:
        try:
            data = open(path, 'rb').read().lower()
        except OSError:
            continue
        scanned += 1
        hits += [(name, path) for name, pattern in patterns.items() if pattern.search(data)]
print(f'phrase scan: {scanned} files')
for name, path in hits:
    print(f'phrase scan: {name} in {path}')
sys.exit(1 if hits else 0)
