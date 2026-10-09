// One capsule in full: the contract and the build that made the state; the private state beside
// the public one at the block the chain answered, each field with its declared storage; the
// interface the bundle declares, in the language's notation; and every call that made the state
// or is still in flight, newest first, with the arguments the user consented to. Read once from
// the inspector's view; the parent refreshes it when the chain answers.

import { showFieldSignature, showSignature, type Json } from '@shieldedtech/capsule-blueprint';
import type { CapsuleView } from '@shieldedtech/capsule-core';
import { t } from '../../lib/i18n';
import { Card, Separator } from '../ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { PanelScreen, PanelHeader } from '../moth/panel';

const short = (hex: string) => (hex.length > 18 ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : hex);

/** A value as the screen shows it: a scalar inline, a collection or struct laid out. */
function Shown({ value }: { value: Json }) {
  if (typeof value !== 'object' || value === null) {
    return <span className="break-all font-mono text-xs">{JSON.stringify(value)}</span>;
  }
  if (Array.isArray(value) && value.length === 0) {
    return <span className="font-mono text-xs text-muted-foreground">{t('capsule_detailEmpty')}</span>;
  }
  return <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(value, null, 2)}</pre>;
}

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
  if (names.length === 0) {
    return <p className="m-0 px-4 py-[13px] text-[13px] text-muted-foreground">{empty}</p>;
  }
  return (
    <>
      {names.map((name, index) => {
        const value = values[name];
        return (
          <div key={name}>
            {index > 0 && <Separator />}
            <div className="flex flex-col gap-1 px-4 py-[13px]">
              <span className="text-sm font-semibold">
                {name} <span className="font-mono text-xs font-normal text-muted-foreground">{showFieldSignature(fields[name]!)}</span>
              </span>
              {value === undefined ? <span className="text-xs text-muted-foreground">{t('capsule_detailNotRead')}</span> : <Shown value={value} />}
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
          {capsule.inFlight.length === 0 && history.length === 0 ? (
            <p className="m-0 text-[13px] text-muted-foreground">{t('capsule_detailNoCalls')}</p>
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
