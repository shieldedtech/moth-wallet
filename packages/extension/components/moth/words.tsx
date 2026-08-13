// 24-word seed phrase grids (4 columns): read-only chips for backup,
// input cells for import.

import { cn } from '../../lib/ui/cn';
import { splitSeedPhrase } from '../../lib/ui/seed-phrase';

/**
 * Read-only 24-word seed phrase grid, 4 columns of numbered chips.
 * @category setup
 */
export function WordChipGrid({ words, columns = 4 }: { words: string[]; columns?: 3 | 4 }) {
  return (
    <div className={`grid gap-2 ${columns === 3 ? 'grid-cols-3' : 'grid-cols-4'}`}>
      {words.map((word, i) => (
        <span key={i} className="flex items-baseline gap-1.5 rounded-xl bg-card border border-border px-2.5 py-2">
          {/* select-none: the position is scaffolding, not part of the phrase.
              Dragging across the grid and hitting ⌘C otherwise yields
              "1 abandon 2 ability …", which no import field accepts. The Copy
              button is the supported path, but hand-selection is what people
              reach for first and it should not produce garbage. */}
          <span className="select-none font-mono text-[11px] text-foreground/40">{i + 1}</span>
          <span className="text-[13.5px] font-semibold">{word}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * 24 seed-word input cells in 4 columns; filled cells get a solid border,
 * empty ones dashed. Pasting a whole phrase into any cell spreads it.
 * @category setup
 */
export function WordInputGrid({
  words,
  onChange,
}: {
  words: string[];
  onChange: (words: string[]) => void;
}) {
  const setWord = (index: number, value: string) => {
    // Pasting a whole phrase into any cell spreads it across the grid from that
    // cell on. splitSeedPhrase (not /\s+/) so a comma-separated phrase — the
    // shape a spreadsheet or CSV export hands back — spreads too, instead of
    // landing as one unusable "abandon,ability,able" word.
    const parts = splitSeedPhrase(value);
    const next = [...words];
    if (parts.length > 1) {
      parts.slice(0, 24 - index).forEach((part, offset) => {
        next[index + offset] = part;
      });
    } else {
      // parts[0] rather than value.trim(): a lone token still gets its
      // punctuation stripped, so pasting "abandon," into one cell is clean.
      // Empty stays empty — this is also the backspace-to-clear path.
      next[index] = parts[0] ?? '';
    }
    onChange(next);
  };

  return (
    <div className="grid grid-cols-4 gap-2">
      {words.map((word, i) => (
        <label
          key={i}
          className={cn(
            'flex items-center gap-1 rounded-xl border px-2 py-1.5',
            word ? 'border-border bg-card' : 'border-dashed border-border-strong bg-transparent',
          )}
        >
          <span className="font-mono text-[11px] text-foreground/40">{i + 1}</span>
          <input
            value={word}
            onChange={(e) => setWord(i, e.target.value)}
            className="w-full min-w-0 border-0 bg-transparent p-0 text-[13px] font-semibold focus:outline-none"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
      ))}
    </div>
  );
}
