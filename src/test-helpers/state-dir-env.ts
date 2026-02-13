type StateDirEnvSnapshot = {
  hephieStateDir: string | undefined;
  openclawStateDir: string | undefined;
  clawdbotStateDir: string | undefined;
};

export function snapshotStateDirEnv(): StateDirEnvSnapshot {
  return {
    hephieStateDir: process.env.HEPHIE_STATE_DIR,
    openclawStateDir: process.env.OPENCLAW_STATE_DIR,
    clawdbotStateDir: process.env.CLAWDBOT_STATE_DIR,
  };
}

export function restoreStateDirEnv(snapshot: StateDirEnvSnapshot): void {
  if (snapshot.hephieStateDir === undefined) {
    delete process.env.HEPHIE_STATE_DIR;
  } else {
    process.env.HEPHIE_STATE_DIR = snapshot.hephieStateDir;
  }
  if (snapshot.openclawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = snapshot.openclawStateDir;
  }
  if (snapshot.clawdbotStateDir === undefined) {
    delete process.env.CLAWDBOT_STATE_DIR;
  } else {
    process.env.CLAWDBOT_STATE_DIR = snapshot.clawdbotStateDir;
  }
}

export function setStateDirEnv(stateDir: string): void {
  process.env.HEPHIE_STATE_DIR = stateDir;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  delete process.env.CLAWDBOT_STATE_DIR;
}
