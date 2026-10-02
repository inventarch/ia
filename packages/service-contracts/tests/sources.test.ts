import { describe, expect, it } from 'vitest';
import {
  sourceActivateRequest,
  sourceAdmission,
  sourceCommitRequest,
  sourceManifest,
  sourceReceipt,
  sourceUploadRequest,
} from '../src/sources.js';

const hash = 'a'.repeat(64);
const file = (path = '.ia/src/systems/example/records/a.ia') => ({ path, digest: hash });
describe('source wire contracts', () => {
  it('keeps source authority outside exact client requests', () => {
    const request = {
      commandId: 'save',
      workspaceId: 'workspace',
      expectedGeneration: 0,
      expectedHead: null,
      files: [file()],
    };
    expect(sourceCommitRequest.parse(request)).toEqual(request);
    expect(sourceCommitRequest.safeParse({ ...request, owner: 'someone-else' }).success).toBe(false);
    expect(sourceCommitRequest.safeParse({ ...request, actor: 'admin' }).success).toBe(false);
    expect(sourceUploadRequest.safeParse({ digest: hash, text: 'source', path: '/server' }).success).toBe(false);
    expect(
      sourceActivateRequest.safeParse({
        commandId: 'activate',
        workspaceId: 'workspace',
        expectedGeneration: Number.MAX_SAFE_INTEGER + 1,
        revisionId: hash,
      }).success,
    ).toBe(false);
  });
  it.each([
    '.ia/src/../escape.ia',
    '.ia/src/floor/a.ia',
    '.ia/src/FLOOR/a.ia',
    '.ia/src/CON.ia',
    '.ia/src/com¹.ia',
    '.ia/src/a./b.ia',
    '.ia/src/e\u0301.ia',
    '.ia/src/a\\b.ia',
    '.ia/src/a\u007f.ia',
  ])('refuses nonportable owned source path %s', (path) => {
    expect(sourceManifest.safeParse([file(path)]).success).toBe(false);
  });
  it('refuses ambiguous manifests, invalid digests and unsupported receipt shapes', () => {
    expect(sourceManifest.safeParse([file('.ia/src/A.ia'), file('.ia/src/a.ia')]).success).toBe(false);
    expect(sourceManifest.safeParse([{ ...file(), digest: 'not-a-hash' }]).success).toBe(false);
    expect(
      sourceReceipt.safeParse({ workspaceId: 'workspace', generation: -1, draftHead: null, activeHead: null }).success,
    ).toBe(false);
    expect(
      sourceAdmission.safeParse({
        ok: true,
        revision: hash,
        refused: 0,
        diagnostics: [],
        unavailableChecks: [],
        permission: true,
      }).success,
    ).toBe(false);
  });
});
