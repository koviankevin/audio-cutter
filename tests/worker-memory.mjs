// CDP's page heap does not include dedicated workers or their WASM memories.
export async function workerMemory(browser, script = 'decode-worker.js') {
  const cdp = await browser.newBrowserCDPSession();
  const results = [];
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const target of targetInfos.filter((t) => t.type === 'worker' && t.url.endsWith(`/${script}`))) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
      let sequence = 0;
      async function send(method) {
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            cdp.off('Target.receivedMessageFromTarget', receive);
            reject(Error(`Worker CDP timeout: ${method}`));
          }, 5000);
          function receive(event) {
            if (event.sessionId !== sessionId) return;
            const message = JSON.parse(event.message);
            if (message.id !== id) return;
            clearTimeout(timer);
            cdp.off('Target.receivedMessageFromTarget', receive);
            if (message.error) reject(Error(message.error.message));
            else resolve(message.result);
          }
          cdp.on('Target.receivedMessageFromTarget', receive);
          cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method }) }).catch(reject);
        });
      }
      try {
        await send('HeapProfiler.collectGarbage');
        results.push(await send('Runtime.getHeapUsage'));
      } finally {
        await cdp.send('Target.detachFromTarget', { sessionId });
      }
    }
  } finally {
    await cdp.detach();
  }
  return results;
}
