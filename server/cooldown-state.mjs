import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

export const COOLDOWN_STATE_FILE = path.join(DATA_DIR, 'cooldowns.json');
const VERSION = 2;
const validName = (value) => typeof value === 'string' && value.length > 0 && !value.includes('\u0000');

/** Persist only policy and public node/provider/exit identity, never Gateway config. */
export class CooldownStateStore {
  constructor({ file = COOLDOWN_STATE_FILE, logger = () => {} } = {}) {
    this.file = file;
    this.logger = logger;
  }

  load() {
    try {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!state || state.version !== VERSION ||
          !['cooldowns', 'lastMarked', 'identities', 'associations'].every((key) => Array.isArray(state[key]))) {
        throw new Error('unsupported cooldown state');
      }
      const identity = (row, measured) => row && validName(row.node) &&
        (row.provider === null || validName(row.provider)) &&
        (validName(row.ip) || (!measured && row.ip === null));
      const cooldowns = state.cooldowns.filter((row) => row && validName(row.egress) && validName(row.group) && Number.isFinite(row.until));
      const lastMarked = state.lastMarked.filter((row) => row && validName(row.egress) && validName(row.group) && Number.isFinite(row.marked));
      const identities = state.identities.filter((row) => identity(row, true));
      const associations = state.associations.filter((row) => identity(row, false));
      if (cooldowns.length !== state.cooldowns.length || lastMarked.length !== state.lastMarked.length ||
          identities.length !== state.identities.length || associations.length !== state.associations.length) {
        this.logger('warn', '[cooldowns] 忽略损坏的冷却状态记录');
      }
      return {
        cooldowns,
        lastMarked,
        identities: identities.map(({ node, provider, ip }) => ({ node, provider, ip })),
        associations: associations.map(({ node, provider, ip }) => ({ node, provider, ip })),
      };
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger('warn', '[cooldowns] 冷却状态读取失败,继续启动空表');
      return null;
    }
  }

  save({ cooldowns, lastMarked, identities, associations }) {
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temp, `${JSON.stringify({ version: VERSION, cooldowns, lastMarked, identities, associations }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch {}
      return true;
    } catch {
      // Keep the previous complete state intact if replacement is unavailable.
      this.logger('warn', '[cooldowns] 冷却状态保存失败,保留原文件');
      return false;
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch {}
    }
  }
}
