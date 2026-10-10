// The unlocked account's installed capabilities: what this wallet answers when a contract's host
// function asks — by interface, each function and the value it is handed — as an answers document
// the account keeps, typed by each contract's own declaration when it asks (plan §4.7 item 5). The
// demo's credential serves until the account has a document of its own; a dApp never sees either.

import { useCallback, useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { AnswersDocument } from '@shieldedtech/capsule-core';
import { t } from '../../lib/i18n';
import { sendMessage } from '../../lib/messaging/protocol';
import type { CapsuleCapabilitiesDTO } from '../../lib/capsule/protocol';
import { Button } from '../ui/button';
import { Card, Separator } from '../ui/card';
import { PanelScreen, PanelHeader } from '../moth/panel';

const isDocument = (value: unknown): value is AnswersDocument =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((functions) => typeof functions === 'object' && functions !== null && !Array.isArray(functions));

/** A value as the row shows it: strings bare, anything else as compact JSON, long ones cut. */
function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 72 ? `${text.slice(0, 69)}…` : text;
}

export function Capabilities({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<CapsuleCapabilitiesDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await sendMessage('capsuleCapabilitiesGet', undefined));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = async (document: AnswersDocument | null) => {
    try {
      setView(await sendMessage('capsuleCapabilitiesSet', { document }));
      setDraft(null);
      setProblem(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  const save = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft ?? '');
    } catch {
      setProblem(t('capsule_capabilitiesInvalid'));
      return;
    }
    if (!isDocument(parsed)) {
      setProblem(t('capsule_capabilitiesInvalid'));
      return;
    }
    void apply(parsed);
  };

  const interfaces = Object.entries(view?.document ?? {});

  return (
    <PanelScreen
      cta={
        draft === null ? (
          <Button size="lg" onClick={() => setDraft(JSON.stringify(view?.document ?? {}, null, 2))} disabled={view === null}>
            {t('capsule_capabilitiesEdit')}
          </Button>
        ) : (
          <Button size="lg" onClick={save}>
            {t('capsule_capabilitiesSave')}
          </Button>
        )
      }
    >
      <PanelHeader title={t('capsule_capabilitiesTitle')} onBack={onBack} />
      <p className="m-0 text-[13px] text-muted-foreground">{t('capsule_capabilitiesIntro')}</p>
      {error && <p className="m-0 text-[13px] text-destructive">{t('capsule_capabilitiesError', [error])}</p>}
      {draft !== null ? (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={14}
            className="w-full resize-y rounded-[14px] border border-border bg-background p-3 font-mono text-xs"
          />
          {problem && <p className="m-0 text-[13px] text-destructive">{problem}</p>}
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(null);
              setProblem(null);
            }}
          >
            {t('capsule_capabilitiesCancel')}
          </Button>
        </>
      ) : (
        <>
          {view && interfaces.length === 0 && (
            <div className="flex flex-col items-center gap-3 pt-16 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                <KeyRound size={24} className="text-muted-foreground" />
              </span>
              <p className="m-0 font-display text-lg font-bold">{t('capsule_capabilitiesEmptyTitle')}</p>
              <p className="m-0 text-[13px] text-muted-foreground">{t('capsule_capabilitiesEmptyBody')}</p>
            </div>
          )}
          {interfaces.map(([interfaceId, functions]) => (
            <Card key={interfaceId} className="p-0">
              <p className="m-0 px-4 pb-1 pt-3 font-mono text-xs text-muted-foreground">{interfaceId}</p>
              {Object.entries(functions).map(([name, value], index) => (
                <div key={name}>
                  {index > 0 && <Separator />}
                  <div className="px-4 py-[11px]">
                    <span className="block text-sm font-semibold">{name}</span>
                    <span className="block break-all font-mono text-xs text-muted-foreground">{shown(value)}</span>
                  </div>
                </div>
              ))}
            </Card>
          ))}
          {view?.isDefault === true && <p className="m-0 text-[13px] text-muted-foreground">{t('capsule_capabilitiesDemoNote')}</p>}
          {view?.isDefault === false && (
            <Button variant="ghost" onClick={() => void apply(null)}>
              {t('capsule_capabilitiesRestoreDemo')}
            </Button>
          )}
          {problem && <p className="m-0 text-[13px] text-destructive">{problem}</p>}
        </>
      )}
    </PanelScreen>
  );
}
