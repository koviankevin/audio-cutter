import os from 'node:os';

// Measurements are tied to this environment, not a promise about user devices.
export function runtimeInfo(browser) {
  return {
    commit: process.env.GITHUB_SHA || null,
    measuredAt: new Date().toISOString(),
    node: process.version,
    browser: browser.version(),
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpu: os.cpus()[0]?.model,
    cpuCount: os.cpus().length,
    publicRoot: process.env.PUBLIC_ROOT || '.',
  };
}
