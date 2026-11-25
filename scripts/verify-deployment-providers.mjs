// Opt-in deployment preflight. Resolve the same saved settings and document
// bucket as the running application. Never print credentials or provider errors.
if (process.env.WALSHKEN_VERIFY_SERVER_INTEGRATIONS === '1') {
  const { liveKitSettings, recordingStorage, verifyLiveKitConnection, verifyRecordingStorage } = await import('../lib/walshken/livekit.ts');
  let providers;
  try {
    if (process.env.DATABASE_URL) {
      const { database } = await import('../lib/walshken/server.ts');
      const { documentStorage } = await import('../lib/walshken/document-storage.ts');
      const db = database();
      const [calling, recordings, documents] = await Promise.all([
        liveKitSettings(db), recordingStorage(db), documentStorage(db),
      ]);
      providers = { livekit: calling, 'recording-storage': recordings, 'document-storage': documents };
    } else {
      const settings = JSON.parse(process.env.WALSHKEN_SERVER_INTEGRATIONS ?? '{}');
      providers = { ...settings, 'document-storage': settings['document-storage-review'] };
    }
  } catch { throw new Error('Deployment provider settings could not be loaded securely.'); }
  for (const key of ['livekit', 'recording-storage', 'document-storage']) {
    if (!providers[key]) throw new Error(`Required deployment provider is missing: ${key}`);
    try {
      if (key === 'livekit') await verifyLiveKitConnection(providers[key]);
      else await verifyRecordingStorage(providers[key]);
    } catch {
      throw new Error(`Deployment provider authentication or private-storage verification failed: ${key}`);
    }
    console.log(`PASS deployment provider: ${key}`);
  }
}
