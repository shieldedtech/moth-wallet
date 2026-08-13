import { useState } from 'react';

export function App() {
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');

  const handleConnect = async () => {
    setStatus('connecting');
    try {
      // TODO: Connect to Midnight wallet via DApp Connector API
      // const api = await window.midnight.mnLace.enable();
      setStatus('connected');
    } catch {
      setStatus('disconnected');
    }
  };

  return (
    <main style={{ maxWidth: 600, margin: '4rem auto', fontFamily: 'system-ui' }}>
      <h1>{{PROJECT_NAME}}</h1>
      <p>A Midnight DApp. Connect your wallet to get started.</p>

      <button onClick={handleConnect} disabled={status === 'connecting'}>
        {status === 'disconnected' && 'Connect Wallet'}
        {status === 'connecting' && 'Connecting...'}
        {status === 'connected' && 'Connected'}
      </button>

      {status === 'connected' && (
        <section style={{ marginTop: '2rem' }}>
          <h2>Contract Interaction</h2>
          <p>Wire up your contract circuits here.</p>
        </section>
      )}
    </main>
  );
}
