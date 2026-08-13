import { PanelScreen, PanelHeader, NoteCard, Button, Crescent } from '@shieldedtech/moth-extension';
import { Moon } from 'lucide-react';

export const Screen = () => (
  <PanelScreen cta={<Button size="lg">Copy address</Button>}>
    <PanelHeader title="Receive" onBack={() => {}} />
    <NoteCard icon={Moon}>Only send Midnight native tokens here. Anything else may be lost.</NoteCard>
  </PanelScreen>
);

export const DarkUnlock = () => (
  <PanelScreen dark cta={<Button size="lg">Unlock</Button>}>
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <Crescent />
      <h1 className="m-0 font-display text-[28px] font-extrabold">Welcome back</h1>
      <p className="m-0 text-[13.5px] text-muted-foreground">Enter your password to unlock Moth.</p>
    </div>
  </PanelScreen>
);
