export async function preparePreseed(networkId, dependencies) {
  const {networks, status, refresh, onProgress, now = Date.now, startedAt = now()} = dependencies;
  if (networkId !== 'preview' && networkId !== 'preprod') {
    throw new Error(`Unknown network "${networkId}". Expected preview or preprod.`);
  }
  const network = networks[networkId];
  const before = await status(network);
  const reference = await refresh(network, onProgress);
  if (!reference) {
    throw new Error(`Preseed reference for ${networkId} did not reach chain tip.`);
  }

  return {
    network: network.id,
    previousHeight: before.height,
    height: reference.height,
    advancedBy: before.height === null ? null : reference.height - before.height,
    elapsedSeconds: (now() - startedAt) / 1000,
  };
}
