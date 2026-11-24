// Opt-in protected deployment preflight. Never log provider values or errors.
if (process.env.WALSHKEN_VERIFY_SERVER_INTEGRATIONS === '1') {
  const { verifyLiveKitConnection, verifyRecordingStorage } = await import('../lib/walshken/livekit.ts');
  let providers;
  try { providers = JSON.parse(process.env.WALSHKEN_SERVER_INTEGRATIONS ?? '{}'); }
  catch { throw new Error('Protected deployment provider configuration is invalid.'); }
  for (const key of ['livekit', 'recording-storage', 'document-storage-review']) {
    if (!providers[key]) throw new Error(`Required deployment provider is missing: ${key}`);
    try {
      if (key === 'livekit') await verifyLiveKitConnection(providers[key]);
      else await verifyRecordingStorage(providers[key]);
    } catch {
      throw new Error(`Deployment provider authentication or private-storage verification failed: ${key}`);
    }
    console.log(`PASS protected deployment provider: ${key}`);
  }
}
