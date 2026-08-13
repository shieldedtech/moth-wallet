import { DialogShell, Button } from '@shieldedtech/moth-extension';

export const RemoveAccount = () => (
  <DialogShell
    open
    onOpenChange={() => {}}
    title="Remove Savings?"
    actions={
      <>
        <Button variant="outline">Cancel</Button>
        <Button variant="soft-destructive">Remove</Button>
      </>
    }
  >
    This hides the account from Moth. Its addresses and tokens stay on Midnight. You can bring it back anytime with
    your 24 words.
  </DialogShell>
);
