"""Searches files for a recovery phrase and the seed derived from it. Prints only where and what kind
of match, never the matched text.

    python3 -I scripts/phrase-scan.py PHRASE_FILE PATH...   (a PATH may be a directory)

Exits 1 if any file holds them, and 2 if it could not scan: a PATH that holds no readable file, or
any other error. A scan that looked at nothing must not pass.

The phrase is looked for as text (UTF-8 or UTF-16, as WebKit stores localStorage values) and as
base64; the seed as hex, raw bytes, base64 and a JSON array of byte values.
"""
import base64, hashlib, os, re, sys


def base64_forms(data):
    """What `data` looks like inside a longer base64 string, at each of the 3 alignments, in the
    standard and URL-safe alphabets. Characters that also encode neighbouring bytes are dropped."""
    forms = []
    for lead in range(3):
        encoded = base64.b64encode(bytes(lead) + data).rstrip(b'=')
        start = (lead * 8 + 5) // 6  # the first character whose bits are all from `data`
        end = (lead + len(data)) * 8 // 6  # past the last one
        middle = encoded[start:end]
        forms += [middle, middle.translate(bytes.maketrans(b'+/', b'-_'))]
    return forms


def utf16(pattern_text, separator):
    """`words` joined by `separator`, for UTF-16 little- and big-endian text."""
    return [
        separator.join(re.escape(w.encode('utf-16-le')) for w in pattern_text),
        separator.join(re.escape(w.encode('utf-16-be')) for w in pattern_text),
    ]


def main():
    phrase_file, *roots = sys.argv[1:]
    words = open(phrase_file).read().split()
    phrase = ' '.join(words)
    # The wallet's seed is the BIP-39 seed of the phrase, with no passphrase.
    seed = hashlib.pbkdf2_hmac('sha512', phrase.encode(), b'mnemonic', 2048)

    sep = rb'[^a-z]{1,8}'
    sep16 = rb'(?:[^a-z]\x00|\x00[^a-z]){1,8}'
    triples = [words[i:i + 3] for i in range(len(words) - 2)]
    # Matched against the file lowercased, so text in any case is found.
    text = {
        'full phrase': re.compile(sep.join(re.escape(w.encode()) for w in words)),
        '3 consecutive words': re.compile(b'|'.join(sep.join(re.escape(w.encode()) for w in t) for t in triples)),
        'full phrase as UTF-16': re.compile(b'|'.join(utf16(words, sep16))),
        '3 consecutive words as UTF-16': re.compile(b'|'.join(p for t in triples for p in utf16(t, sep16))),
        'seed hex': re.compile(b'(' + seed[:16].hex().encode() + b'|' + seed[32:48].hex().encode() + b')'),
        'seed as a byte array': re.compile(rb'\[\s*' + rb'\s*,\s*'.join(str(b).encode() for b in seed[:12])),
    }
    # Matched against the file as it is: base64 and raw bytes are case-sensitive.
    exact = {
        'full phrase as base64': re.compile(b'|'.join(re.escape(f) for f in base64_forms(phrase.encode()))),
        'seed bytes': re.compile(re.escape(seed[:16]) + b'|' + re.escape(seed[32:48])),
        'seed as base64': re.compile(b'|'.join(re.escape(f) for f in base64_forms(seed[:24]) + base64_forms(seed[32:56]))),
    }

    hits, scanned, empty = [], 0, []
    for root in roots:
        paths = [root] if os.path.isfile(root) else [os.path.join(d, f) for d, _, fs in os.walk(root) for f in fs]
        count = 0
        for path in paths:
            try:
                data = open(path, 'rb').read()
            except OSError:
                continue
            count += 1
            lower = data.lower()
            hits += [(name, path) for name, pattern in text.items() if pattern.search(lower)]
            hits += [(name, path) for name, pattern in exact.items() if pattern.search(data)]
        scanned += count
        if count == 0:
            empty.append(root)
    print(f'phrase scan: {scanned} files')
    for name, path in hits:
        print(f'phrase scan: {name} in {path}')
    for root in empty:
        print(f'phrase scan: error: nothing readable under {root!r}', file=sys.stderr)
    return 1 if hits else 2 if empty else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:  # an error must not read as "found" or as a pass
        print(f'phrase scan: error: {type(error).__name__}', file=sys.stderr)
        sys.exit(2)
