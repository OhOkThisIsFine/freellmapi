import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  restrictToOwner,
  restrictAllToOwner,
  windowsRestrictArgs,
  type ExecFileSyncLike,
} from '../../lib/file-permissions.js';

// Every Windows assertion here runs on Linux CI too: the child_process seam is
// injected, so nothing spawns and nothing depends on being on Windows. The
// end-to-end "does the ACL actually land" check lives in db/hardening.test.ts,
// which is necessarily Windows-only.

const SID = 'S-1-5-21-111-222-333-1002';
const WHOAMI_OUT = `"E-DESK\\ethan","${SID}"\r\n`;

const created: string[] = [];

function tempFile(contents = 'x'): string {
  const p = path.join(os.tmpdir(), `freeapi-fileperms-${Date.now()}-${Math.random()}`);
  fs.writeFileSync(p, contents);
  created.push(p);
  return p;
}

/** A fake icacls/whoami that records calls and answers the SID lookup. */
function fakeExec(overrides?: { onIcacls?: () => string }): ExecFileSyncLike & { calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const fn = ((file: string, args: string[]) => {
    calls.push({ file, args });
    if (file.toLowerCase().endsWith('whoami.exe')) return WHOAMI_OUT;
    return overrides?.onIcacls ? overrides.onIcacls() : '';
  }) as ExecFileSyncLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const p of created.splice(0)) {
    try { fs.unlinkSync(p); } catch { /* best effort */ }
  }
});

describe('windowsRestrictArgs', () => {
  it('drops inheritance and replaces the ACL with owner + SYSTEM + Administrators', () => {
    expect(windowsRestrictArgs('C:\\data\\freeapi.db', SID)).toEqual([
      'C:\\data\\freeapi.db',
      '/inheritance:r',
      '/grant:r', `*${SID}:(F)`,
      '/grant:r', '*S-1-5-18:(F)',
      '/grant:r', '*S-1-5-32-544:(F)',
    ]);
  });

  it('names the privileged principals by SID, not by their localized display names', () => {
    // BUILTIN\Administrators is "VORDEFINIERT\Administratoren" on a German
    // Windows; matching on names would silently harden nothing there.
    const args = windowsRestrictArgs('f', SID).join(' ');
    expect(args).not.toMatch(/Administrators|SYSTEM/i);
    expect(args).toContain('*S-1-5-32-544');
    expect(args).toContain('*S-1-5-18');
  });

  it('replaces rather than adds, so repeated hardening is idempotent', () => {
    expect(windowsRestrictArgs('f', SID)).toContain('/grant:r');
    expect(windowsRestrictArgs('f', SID)).not.toContain('/grant');
  });
});

describe('restrictToOwner on Windows', () => {
  it('resolves the owner SID and hands icacls the restriction', () => {
    const target = tempFile();
    const exec = fakeExec();

    expect(restrictToOwner(target, { platform: 'win32', execFileSync: exec })).toBe(true);

    expect(exec.calls).toHaveLength(2);
    expect(exec.calls[0].file.toLowerCase()).toContain('whoami.exe');
    expect(exec.calls[0].args).toEqual(['/user', '/fo', 'csv', '/nh']);
    expect(exec.calls[1].file.toLowerCase()).toContain('icacls.exe');
    expect(exec.calls[1].args).toEqual(windowsRestrictArgs(target, SID));
  });

  it('invokes the System32 binaries by absolute path, never off PATH', () => {
    // A Git Bash / MSYS `whoami` shadows the Windows one and fails outright,
    // and letting PATH pick the binary that hardens a file is a hijack vector.
    const target = tempFile();
    const exec = fakeExec();
    restrictToOwner(target, { platform: 'win32', execFileSync: exec });

    for (const call of exec.calls) {
      expect(path.isAbsolute(call.file)).toBe(true);
      expect(call.file.replace(/\\/g, '/').toLowerCase()).toContain('/system32/');
    }
  });

  it('skips the SID lookup when the caller already resolved it', () => {
    const target = tempFile();
    const exec = fakeExec();

    restrictToOwner(target, { platform: 'win32', execFileSync: exec, ownerSid: SID });

    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].file.toLowerCase()).toContain('icacls.exe');
  });

  it('reports failure instead of throwing when icacls fails', () => {
    const target = tempFile();
    const exec = fakeExec({ onIcacls: () => { throw new Error('Access is denied.'); } });

    expect(() => restrictToOwner(target, { platform: 'win32', execFileSync: exec })).not.toThrow();
    expect(restrictToOwner(target, { platform: 'win32', execFileSync: exec })).toBe(false);
  });

  it('reports failure when the owner SID cannot be determined', () => {
    const target = tempFile();
    const exec = (() => 'not a csv row') as ExecFileSyncLike;

    expect(restrictToOwner(target, { platform: 'win32', execFileSync: exec })).toBe(false);
  });

  it('reports failure when the SID lookup itself throws', () => {
    const target = tempFile();
    const exec = (() => { throw new Error('ENOENT'); }) as ExecFileSyncLike;

    expect(restrictToOwner(target, { platform: 'win32', execFileSync: exec })).toBe(false);
  });

  it('does not cache an injected fake between calls', () => {
    // The real SID is memoized (a process cannot change its own SID), but a
    // memoized fake would leak one test's answer into the next.
    const target = tempFile();
    const first = fakeExec();
    restrictToOwner(target, { platform: 'win32', execFileSync: first });

    const second = fakeExec();
    restrictToOwner(target, { platform: 'win32', execFileSync: second });

    expect(second.calls[0].file.toLowerCase()).toContain('whoami.exe');
  });
});

describe('restrictToOwner on POSIX', () => {
  it('uses chmod and never spawns a process', () => {
    const target = tempFile();
    const exec = fakeExec();

    expect(restrictToOwner(target, { platform: 'linux', execFileSync: exec })).toBe(true);
    expect(exec.calls).toHaveLength(0);
  });

  it('reports failure instead of throwing when chmod fails', () => {
    const target = tempFile();
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => { throw new Error('EPERM'); });

    expect(restrictToOwner(target, { platform: 'linux' })).toBe(false);
  });
});

describe('restrictToOwner on a missing file', () => {
  it('treats an absent target as nothing to do, on either platform', () => {
    // SQLite's -wal/-shm sidecars do not exist until the first write.
    const missing = path.join(os.tmpdir(), `freeapi-fileperms-absent-${Date.now()}`);
    const exec = fakeExec();

    expect(restrictToOwner(missing, { platform: 'win32', execFileSync: exec })).toBe(true);
    expect(restrictToOwner(missing, { platform: 'linux', execFileSync: exec })).toBe(true);
    expect(exec.calls).toHaveLength(0);
  });
});

describe('restrictAllToOwner', () => {
  it('resolves the owner SID once for the whole batch', () => {
    const targets = [tempFile(), tempFile(), tempFile()];
    const exec = fakeExec();

    expect(restrictAllToOwner(targets, { platform: 'win32', execFileSync: exec })).toEqual([]);

    const whoamiCalls = exec.calls.filter(c => c.file.toLowerCase().endsWith('whoami.exe'));
    expect(whoamiCalls).toHaveLength(1);
    expect(exec.calls.filter(c => c.file.toLowerCase().endsWith('icacls.exe'))).toHaveLength(3);
  });

  it('returns the targets it could not restrict rather than throwing', () => {
    const ok = tempFile();
    const bad = tempFile();
    const exec = ((file: string, args: string[]) => {
      if (file.toLowerCase().endsWith('whoami.exe')) return WHOAMI_OUT;
      if (args[0] === bad) throw new Error('Access is denied.');
      return '';
    }) as ExecFileSyncLike;

    expect(restrictAllToOwner([ok, bad], { platform: 'win32', execFileSync: exec })).toEqual([bad]);
  });

  it('does not report a missing sidecar as a failure', () => {
    const present = tempFile();
    const absent = `${present}-wal`;

    expect(restrictAllToOwner([present, absent], {
      platform: 'win32',
      execFileSync: fakeExec(),
      ownerSid: SID,
    })).toEqual([]);
  });
});
