import { expect, it } from 'vitest';
import {
  createOrganizationRequest,
  createWorkspaceRequest,
  membershipRequest,
  updateWorkspaceRequest,
  workspaceView,
  organizationView,
  directoryReceipt,
  departmentView,
  membershipView,
} from '../src/tenancy.js';

it('closes administrative requests and refuses acting identities or storage namespace injection', () => {
  const request = { commandId: 'create', expectedRevision: 0, title: 'Research' };
  expect(createOrganizationRequest.parse(request)).toEqual(request);
  for (const field of ['actor', 'owner', 'storageOwner'])
    expect(() => createOrganizationRequest.parse({ ...request, [field]: 'other' })).toThrow();
  expect(() =>
    createWorkspaceRequest.parse({
      ...request,
      organizationId: 'org',
      departmentId: null,
      expectedRevision: Number.MAX_SAFE_INTEGER + 1,
    }),
  ).toThrow();
  expect(() =>
    membershipRequest.parse({
      commandId: 'grant',
      organizationId: 'org',
      departmentId: 'department',
      expectedRevision: 1,
      memberId: 'bob',
      role: 'owner',
    }),
  ).toThrow();
  expect(() =>
    updateWorkspaceRequest.parse({ commandId: 'edit', workspaceId: 'workspace', expectedRevision: 1 }),
  ).toThrow();
});

it('refuses inconsistent public containment, permissions, and receipt selectors', () => {
  const workspace = {
    id: 'workspace',
    kind: 'personal',
    organizationId: null,
    departmentId: null,
    title: 'Personal',
    archived: false,
    permissions: ['read'],
    created: '2026-09-19T00:00:00.000Z',
  };
  expect(() => workspaceView.parse({ ...workspace, departmentId: 'department' })).toThrow();
  expect(() => workspaceView.parse({ ...workspace, archived: true, permissions: ['read', 'execute'] })).toThrow();
  expect(() => workspaceView.parse({ ...workspace, commandRevision: 3 })).toThrow();
  expect(() =>
    departmentView.parse({
      id: 'department',
      organizationId: 'org',
      title: 'Department',
      permissions: ['read'],
      commandRevision: 3,
    }),
  ).toThrow();
  expect(() =>
    membershipView.parse({ organizationId: 'org', departmentId: 'department', memberId: 'alice', role: 'owner' }),
  ).toThrow();
  const receipt = {
    action: 'workspace.create',
    commandId: 'create',
    organizationId: 'org',
    departmentId: null,
    workspaceId: 'workspace',
    memberId: null,
    revision: 2,
    created: workspace.created,
  };
  expect(directoryReceipt.parse(receipt)).toEqual(receipt);
  for (const change of [{ workspaceId: null }, { memberId: 'other' }, { organizationId: null }, { revision: 0 }])
    expect(() => directoryReceipt.parse({ ...receipt, ...change })).toThrow();
});

it('keeps public directory views free of storage keys and hidden organization revisions', () => {
  const summary = { id: 'org', title: 'Research', role: 'department' };
  expect(organizationView.parse(summary)).toEqual(summary);
  expect(() => organizationView.parse({ ...summary, commandRevision: 4 })).toThrow();
  const view = {
    id: 'workspace',
    kind: 'organization',
    organizationId: 'org',
    departmentId: null,
    title: 'Work',
    archived: false,
    permissions: ['read'],
    created: '2026-09-19T00:00:00.000Z',
  };
  expect(workspaceView.parse(view)).toEqual(view);
  expect(() => workspaceView.parse({ ...view, owner: 'database-key' })).toThrow();
  expect(() => workspaceView.parse({ ...view, created: 'yesterday' })).toThrow();
});
