import { StatusHero } from '@shieldedtech/moth-extension';

export const Success = () => (
  <StatusHero
    state="success"
    title="120 NIGHT is on its way"
    sub="Unshielded transfer, it usually arrives in under a minute."
  />
);

export const Failure = () => (
  <StatusHero
    state="failure"
    title="That didn't go through"
    sub="Your 120 NIGHT hasn't moved. Nothing was spent."
  />
);

export const Pending = () => <StatusHero state="pending" title="Sending 120 NIGHT…" />;
