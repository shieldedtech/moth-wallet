# Moth conventions

Moth is a wallet for the Midnight network: bold flat fintech, Midnight Ink + Moonlime, pill buttons, chunky display type, plain-spoken copy.

## Setup

No provider is required — components style themselves from CSS custom properties defined in `styles.css`. Screens render on the paper background (`--background: #FBFAF7`). For dark moments (welcome, unlock, setup-complete) either use `PanelScreen` with its `dark` prop, or add the `dark` class to a wrapping container — it swaps the token set to the Ink theme.

## Styling idiom

Tailwind utility classes plus the Moth tokens. **The shipped stylesheet contains only the utilities the wallet's own code uses — do not invent class names.** Verified vocabulary to build with:

- Surfaces: `bg-background` (paper), `bg-card` (white), `bg-muted` (sand), `bg-accent` (lime tint), `bg-secondary` (ink), `bg-primary` (Moonlime), `bg-error-tint`
- Text: `text-foreground`, `text-muted-foreground`, `text-secondary-foreground`, `text-accent-foreground`, `text-destructive`, `text-link` (green links), `text-success`
- Borders: `border-border`, `border-input`; radius: `rounded-full` (buttons/pills always), `rounded-2xl` (inputs), `rounded-xl` (word chips), `rounded-[18px]` (cards), `rounded-[24px]` (QR card)
- Type: `font-display` (Bricolage Grotesque 700/800 — headlines, titles, amounts), default sans is Instrument Sans, `font-mono` for addresses (always middle-truncated, e.g. `mn_addr1…c2vx`); weights `font-semibold`/`font-bold`/`font-extrabold`; sizes `text-xs`/`text-sm`/`text-lg` and bracket sizes like `text-[13px]`, `text-[12.5px]`, `text-[42px]`
- Layout: `flex`, `flex-col`, `flex-1`, `items-center`, `justify-between`, `justify-center`, `gap-2`, `gap-3`, `gap-4`, `p-4`, `px-4`, `w-full`, `grid-cols-4`

If a utility you want isn't in `styles.css`, use an inline `style` or the tokens directly (`var(--primary)`, `var(--muted)`, `var(--error-tint)`, `var(--disabled-fill)` — all defined in `styles.css`).

## Composition rules

- One primary Button (`variant` default = Moonlime, `size="lg"`) per screen, pinned to the panel bottom — `PanelScreen`'s `cta` slot does the pinning. Secondary action below it is a `ghost` Button (green text), or an equal-width pair for Cancel/Confirm.
- Screens are side-panel sized: ~400px wide column. Scaffold with `PanelScreen` + `PanelHeader`; list content lives in `Card` with `p-0`, rows, and `Separator`; notes use `NoteCard` (info/neutral/error) — never a bare alert.
- Destructive actions: red text menu items or `soft-destructive` Button in a `DialogShell` — never a saturated red fill.
- Copy: sentence case, no dashes, no exclamation marks; lead with what happened to the user's money.
- Domain: NIGHT is the native token; DUST pays all fees and can never be sent or received; shielded transfers are private, unshielded are public.

## Where the truth lives

Read `styles.css` (tokens + full utility set) before styling. Each component ships `<Name>.d.ts` (the props contract) and `<Name>.prompt.md` (usage). Voice and spacing guidance also lives in `guidelines/`.

## Example

```tsx
import { PanelScreen, PanelHeader, Card, Separator, NoteCard, Button, TokenIcon } from '@shieldedtech/moth-extension';
import { Moon } from 'lucide-react';

const Assets = () => (
  <PanelScreen cta={<Button size="lg">Send</Button>}>
    <PanelHeader title="Assets" onBack={() => {}} />
    <Card className="p-0">
      <div className="flex items-center gap-3 px-4 py-[15px]">
        <TokenIcon kind="night" />
        <span className="flex-1 text-sm font-semibold">NIGHT</span>
        <span className="text-sm font-semibold">1,284.09</span>
      </div>
      <Separator />
      <div className="flex items-center gap-3 px-4 py-[15px]">
        <TokenIcon kind="shielded" />
        <span className="flex-1 text-sm font-semibold">mUSD</span>
        <span className="text-sm font-semibold">250.00</span>
      </div>
    </Card>
    <NoteCard icon={Moon}>Only send Midnight native tokens here. Anything else may be lost.</NoteCard>
  </PanelScreen>
);
```
