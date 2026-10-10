// One capsule in full: the contract and the build that made the state; the private state beside
// the public one at the block the chain answered, each field with its declared storage; the
// interface the bundle declares, in the language's notation; and every call that made the state
// or is still in flight, newest first, with the arguments the user consented to. Read from the
// inspector's view, which the parent re-reads as transactions settle; a field whose value moved
// since the last reading is marked for a while, with what it was, so a landing is seen to land.

import { useEffect, useRef, useState } from 'react';
import { presentField, showFieldSignature, showSignature, type Json } from '@shieldedtech/capsule-blueprint';
import { changedFields, type CapsuleView, type FieldChange } from '@shieldedtech/capsule-host-browser';
import { t } from '../../lib/i18n';
import { Card, Separator } from '../ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { CapsuleValue, countOf, isInline } from '../moth/capsule-value';
import { PanelScreen, PanelHeader } from '../moth/panel';

const short = (hex: string) => (hex.length > 18 ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : hex);

/** A call as one line: the circuit with the arguments it was asked with, or the asked call it ran inside. */
function callLine(call: { circuit: string; arguments?: readonly Json[]; within?: { address: string; circuit: string } }): string {
  if (call.arguments !== undefined) {
    return `${call.circuit}(${call.arguments.map((a) => JSON.stringify(a)).join(', ')})`;
  }
  if (call.within !== undefined) {
    return `${call.circuit} · ${t('capsule_detailWithin', [call.within.circuit, short(call.within.address)])}`;
  }
  return call.circuit;
}

/** How long a field that just moved stays marked. */
const CHANGED_FOR_MS = 8_000;

function Fields({
  fields,
  values,
  empty,
}: {
  fields: CapsuleView['abi']['localStateSignatures']['fields'];
  values: Readonly<Record<string, Json>>;
  empty: string;
}) {
  const names = Object.keys(fields);
  // What the last reading showed, and what moved since: marked for a while, then let go.
  const previous = useRef<Readonly<Record<string, Json>> | undefined>(undefined);
  const [changed, setChanged] = useState<Map<string, FieldChange>>(() => new Map());
  useEffect(() => {
    const moved = changedFields(previous.current, values, Date.now());
    previous.current = values;
    if (moved.size === 0) {
      return undefined;
    }
    setChanged((current) => new Map([...current, ...moved]));
    const timer = setTimeout(() => {
      setChanged((current) => new Map([...current].filter(([, mark]) => Date.now() - mark.at < CHANGED_FOR_MS)));
    }, CHANGED_FOR_MS + 50);
    return () => clearTimeout(timer);
  }, [values]);
  if (names.length === 0) {
    return <p className="m-0 px-4 py-[13px] text-[13px] text-muted-foreground">{empty}</p>;
  }
  return (
    <>
      {names.map((name, index) => {
        const signature = fields[name]!;
        const value = values[name];
        const presented = value === undefined ? undefined : presentField(signature, value);
        const inline = presented === undefined || isInline(presented);
        const mark = changed.get(name);
        const was = mark === undefined || mark.was === undefined ? undefined : presentField(signature, mark.was);
        return (
          <div key={name}>
            {index > 0 && <Separator />}
            <div
              className={`flex flex-col gap-2 px-4 py-[13px] transition-colors duration-1000 ${mark === undefined ? '' : 'bg-success-tint'}`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{name}</span>
                  <span className="block font-mono text-[11px] text-muted-foreground">{showFieldSignature(signature)}</span>
                </span>
                <span className="shrink-0 text-right">
                  {presented === undefined ? (
                    <span className="text-[13px] italic text-muted-foreground">{t('capsule_detailNotRead')}</span>
                  ) : inline ? (
                    <span className="inline-flex items-baseline gap-1.5">
                      {was !== undefined && isInline(was) && (
                        <span className="text-[12px] text-muted-foreground line-through">
                          <CapsuleValue value={was} />
                        </span>
                      )}
                      {was !== undefined && isInline(was) && <span className="text-[12px] text-muted-foreground">→</span>}
                      <CapsuleValue value={presented} />
                    </span>
                  ) : (
                    <span className="text-[12px] text-muted-foreground">
                      {mark !== undefined && t('capsule_detailJustChanged')}
                      {mark !== undefined && ' · '}
                      {countOf(presented)}
                    </span>
                  )}
                </span>
              </div>
              {presented !== undefined && !inline ? <CapsuleValue value={presented} /> : null}
            </div>
          </div>
        );
      })}
    </>
  );
}

function Section({ title, note }: { title: string; note?: string }) {
  return (
    <p className="m-0 pt-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
      {title}
      {note && <span className="block font-normal normal-case tracking-normal">{note}</span>}
    </p>
  );
}

export function CapsuleDetail({ capsule, onBack }: { capsule: CapsuleView; onBack: () => void }) {
  const { abi } = capsule;
  const interfaceRows: Array<{ key: string; kind: string; line: string; note?: string }> = [
    ...Object.entries(abi.circuitSignatures).map(([name, signature]) => ({
      key: `c-${name}`,
      kind: t('capsule_detailCircuit'),
      line: showSignature(name, signature),
      note: signature.provable ? t('capsule_detailProved') : t('capsule_detailNotProved'),
    })),
    ...Object.entries(abi.localStateSignatures.functions).map(([name, signature]) => ({
      key: `f-${name}`,
      kind: t('capsule_detailLocalFunction'),
      line: showSignature(name, signature),
      ...(signature.readsLedger ? { note: t('capsule_detailReadsLedger') } : {}),
    })),
    ...Object.entries(abi.hostInterfaceSignatures).flatMap(([id, byName]) =>
      Object.entries(byName).map(([name, signature]) => ({
        key: `h-${id}-${name}`,
        kind: t('capsule_detailHost', [id]),
        line: showSignature(name, signature),
      })),
    ),
    ...(abi.constructorSignature.argumentTypes.length > 0
      ? [
          {
            key: 'constructor',
            kind: t('capsule_detailConstructor'),
            line: showSignature('constructor', { ...abi.constructorSignature, resultType: { tag: 'Tuple', types: [] } }),
          },
        ]
      : []),
  ];
  const history = [...capsule.history].reverse();
  // A record folded before the wallet kept a history is counted but not listed; the count says so.
  const unrecorded = capsule.folded - capsule.history.filter((entry) => entry.result === 'folded').length;
  return (
    <PanelScreen>
      <PanelHeader title={t('capsule_detailTitle', [capsule.bundle])} onBack={onBack} />
      <Card className="px-4 py-[13px]">
        <span className="block break-all font-mono text-xs">{capsule.address}</span>
        <span className="block pt-1 text-xs text-muted-foreground">
          {t('capsule_buildLabel')} {short(capsule.fingerprint)} · {t('capsule_foldedCount', [capsule.folded])}
        </span>
        <span className="block text-xs text-muted-foreground">
          {t('capsule_detailBlockLine', [capsule.block.height, new Date(capsule.block.timestamp).toLocaleString()])}
        </span>
      </Card>
      {/* Every tab is mounted and hidden by state rather than unmounted, so a static render and a test see all three. */}
      <Tabs defaultValue="state">
        <TabsList>
          <TabsTrigger value="state">{t('capsule_detailTabState')}</TabsTrigger>
          <TabsTrigger value="interface">{t('capsule_detailTabInterface')}</TabsTrigger>
          <TabsTrigger value="calls">{t('capsule_detailTabCalls')}</TabsTrigger>
        </TabsList>
        <TabsContent value="state" forceMount className="flex flex-col gap-3 data-[state=inactive]:hidden">
          <Section title={t('capsule_detailPrivateTitle')} note={t('capsule_detailPrivateNote')} />
          <Card className="p-0">
            <Fields fields={abi.localStateSignatures.fields} values={capsule.fields} empty={t('capsule_detailNoPrivate')} />
          </Card>
          <Section title={t('capsule_detailPublicTitle')} note={t('capsule_detailPublicNote')} />
          <Card className="p-0">
            <Fields fields={abi.ledgerSignatures.fields} values={capsule.ledger} empty={t('capsule_detailNoPublic')} />
          </Card>
        </TabsContent>
        <TabsContent value="interface" forceMount className="flex flex-col gap-3 data-[state=inactive]:hidden">
          <Card className="p-0">
            {interfaceRows.map((row, index) => (
              <div key={row.key}>
                {index > 0 && <Separator />}
                <div className="flex flex-col gap-0.5 px-4 py-[13px]">
                  <span className="text-xs text-muted-foreground">
                    {row.kind}
                    {row.note && ` · ${row.note}`}
                  </span>
                  <span className="break-all font-mono text-xs">{row.line}</span>
                </div>
              </div>
            ))}
          </Card>
        </TabsContent>
        <TabsContent value="calls" forceMount className="flex flex-col gap-3 data-[state=inactive]:hidden">
          {unrecorded > 0 && (
            <p className="m-0 text-[13px] text-muted-foreground">{t('capsule_detailUnrecorded', [unrecorded])}</p>
          )}
          {capsule.inFlight.length === 0 && history.length === 0 ? (
            <p className="m-0 text-[13px] text-muted-foreground">
              {t(unrecorded > 0 ? 'capsule_detailNoCallsSince' : 'capsule_detailNoCalls')}
            </p>
          ) : (
            <Card className="p-0">
              {capsule.inFlight.map((call, index) => (
                <div key={`${call.transaction}-${index}`}>
                  {index > 0 && <Separator />}
                  <div className="flex flex-col gap-0.5 px-4 py-[13px]">
                    <span className="break-all font-mono text-xs">{callLine(call)}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(call.submittedAt).toLocaleString()} · {short(call.transaction)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t('capsule_detailInFlightLine', [new Date(call.ttl).toLocaleTimeString()])}
                    </span>
                  </div>
                </div>
              ))}
              {history.map((entry, index) => (
                <div key={`${entry.transaction}-${entry.circuit}-${index}`}>
                  {(index > 0 || capsule.inFlight.length > 0) && <Separator />}
                  <div className="flex flex-col gap-0.5 px-4 py-[13px]">
                    <span className="break-all font-mono text-xs">{callLine(entry)}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(entry.submittedAt).toLocaleString()} · {short(entry.transaction)}
                    </span>
                    <span className={entry.status === 'success' ? 'text-xs text-success' : 'text-xs text-destructive'}>
                      {t('capsule_detailOutcomeLine', [entry.status, entry.block.height, entry.result])}
                      {entry.detail && ` (${entry.detail})`}
                    </span>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </PanelScreen>
  );
}
