"""Tests for phrase-scan.py: every form of the phrase and seed it looks for is found wherever it sits
in a file, and a scan that read nothing or failed does not pass.

    python3 -I scripts/test_phrase_scan.py
"""
import base64, hashlib, json, os, subprocess, sys, tempfile, unittest

SCAN = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'phrase-scan.py')
# A made-up phrase: the scan only needs words, not a valid checksum.
WORDS = ('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november '
         'oscar papa quebec romeo sierra tango uniform victor whiskey xray').split()
PHRASE = ' '.join(WORDS).encode()
SEED = hashlib.pbkdf2_hmac('sha512', PHRASE, b'mnemonic', 2048)

FORMS = {
    'UTF-8': PHRASE,
    'upper case': PHRASE.upper(),
    'JSON array of words': json.dumps(WORDS).encode(),
    'three words': b' '.join(w.encode() for w in WORDS[5:8]),
    'UTF-16 LE': ' '.join(WORDS).encode('utf-16-le'),
    'UTF-16 BE': ' '.join(WORDS).encode('utf-16-be'),
    'three words, UTF-16': ' '.join(WORDS[9:12]).encode('utf-16-le'),
    'URL-safe base64': base64.urlsafe_b64encode(b'a' + PHRASE),
    'seed hex': SEED.hex().encode(),
    'seed hex, upper case': SEED.hex().upper().encode(),
    'seed bytes': SEED,
    'seed byte array': json.dumps(list(SEED)).encode(),
}
# base64 of the same bytes depends on where they start, so try every alignment.
for lead in range(3):
    FORMS[f'base64, offset {lead}'] = base64.b64encode(bytes(lead) + PHRASE)
    FORMS[f'seed base64, offset {lead}'] = base64.b64encode(bytes(lead) + SEED)


class PhraseScanTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.phrase = self.path('phrase', PHRASE)

    def tearDown(self):
        self.dir.cleanup()

    def path(self, name, data):
        path = os.path.join(self.dir.name, name)
        with open(path, 'wb') as f:
            f.write(data)
        return path

    def scan(self, *paths):
        return subprocess.run([sys.executable, '-I', SCAN, self.phrase, *paths], capture_output=True, text=True)

    def test_each_form_is_found(self):
        for name, data in FORMS.items():
            with self.subTest(name):
                result = self.scan(self.path('leak', os.urandom(37) + data + os.urandom(41)))
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertNotIn(PHRASE.decode(), result.stdout + result.stderr, 'the phrase is never printed')

    def test_a_file_without_it_passes(self):
        result = self.scan(self.path('clean', os.urandom(100_000) + b'alpha bravo zulu'))
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_a_path_with_nothing_to_read_fails(self):
        clean = self.path('clean', b'nothing here')
        empty = os.path.join(self.dir.name, 'empty')
        os.mkdir(empty)
        for missing in (empty, '', os.path.join(self.dir.name, 'missing')):
            with self.subTest(repr(missing)):
                self.assertEqual(self.scan(clean, missing).returncode, 2)

    def test_an_error_fails_without_reading_as_a_find(self):
        self.phrase = os.path.join(self.dir.name, 'no-phrase-file')
        self.assertEqual(self.scan(self.path('clean', b'x')).returncode, 2)


if __name__ == '__main__':
    unittest.main()
