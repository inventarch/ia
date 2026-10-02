import { id, z } from './index.js';
export { z } from './index.js';

export const directorySubject = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Expected an opaque subject');
export const directoryTitle = z
  .string()
  .min(1)
  .max(160)
  .refine(
    (value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value),
    'Expected a bounded display title',
  );
export const directoryRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const directoryRole = z.enum(['owner', 'admin', 'editor', 'viewer']);
export const directoryAction = z.enum(['read', 'write', 'execute', 'admin', 'purge']);
export type DirectoryRole = z.infer<typeof directoryRole>;
export type DirectoryAction = z.infer<typeof directoryAction>;
const command = { commandId: id, expectedRevision: directoryRevision };
export const createOrganizationRequest = z.strictObject({
  ...command,
  expectedRevision: z.literal(0),
  title: directoryTitle,
});
export const renameOrganizationRequest = z.strictObject({ ...command, organizationId: id, title: directoryTitle });
export const createDepartmentRequest = renameOrganizationRequest;
export const renameDepartmentRequest = z.strictObject({
  ...command,
  organizationId: id,
  departmentId: id,
  title: directoryTitle,
});
export const createWorkspaceRequest = z.strictObject({
  ...command,
  organizationId: id,
  departmentId: id.nullable(),
  title: directoryTitle,
});
export const membershipRequest = z
  .strictObject({
    ...command,
    organizationId: id,
    departmentId: id.nullable(),
    memberId: directorySubject,
    role: directoryRole.nullable(),
  })
  .refine(
    (value) => value.departmentId === null || value.role !== 'owner',
    'A department cannot grant organization ownership',
  );
export const updateWorkspaceRequest = z
  .strictObject({ ...command, workspaceId: id, title: directoryTitle.optional(), archived: z.boolean().optional() })
  .refine((value) => value.title !== undefined || value.archived !== undefined, 'Expected a metadata change');

export const organizationView = z
  .strictObject({
    id,
    title: directoryTitle,
    role: z.enum(['owner', 'admin', 'editor', 'viewer', 'department']),
    commandRevision: directoryRevision.optional(),
  })
  .refine(
    (value) => value.commandRevision === undefined || ['owner', 'admin'].includes(value.role),
    'Only organization administrators receive its command revision',
  );
const permittedActions = z.array(directoryAction).refine((value) => new Set(value).size === value.length);
export const departmentView = z
  .strictObject({
    id,
    organizationId: id,
    title: directoryTitle,
    permissions: permittedActions,
    commandRevision: directoryRevision.optional(),
  })
  .refine((value) => value.commandRevision === undefined || value.permissions.includes('admin'));
export const workspaceView = z
  .strictObject({
    id,
    kind: z.enum(['personal', 'organization']),
    organizationId: id.nullable(),
    departmentId: id.nullable(),
    title: directoryTitle,
    archived: z.boolean(),
    permissions: permittedActions,
    commandRevision: directoryRevision.optional(),
    created: z.iso.datetime(),
  })
  .refine((value) =>
    value.kind === 'personal'
      ? value.organizationId === null && value.departmentId === null
      : value.organizationId !== null,
  )
  .refine((value) => !value.archived || !value.permissions.some((action) => action === 'write' || action === 'execute'))
  .refine((value) => value.commandRevision === undefined || value.permissions.includes('admin'));
export const membershipView = z
  .strictObject({ organizationId: id, departmentId: id.nullable(), memberId: directorySubject, role: directoryRole })
  .refine((value) => value.departmentId === null || value.role !== 'owner');
export const directoryCommandAction = z.enum([
  'organization.create',
  'organization.rename',
  'department.create',
  'department.rename',
  'workspace.create',
  'workspace.update',
  'membership.set',
]);
export const directoryReceipt = z
  .strictObject({
    commandId: id,
    action: directoryCommandAction,
    organizationId: id.nullable(),
    departmentId: id.nullable(),
    workspaceId: id.nullable(),
    memberId: directorySubject.nullable(),
    revision: directoryRevision.refine((value) => value > 0),
    created: z.iso.datetime(),
  })
  .refine((value) => {
    switch (value.action) {
      case 'organization.create':
      case 'organization.rename':
        return (
          value.organizationId !== null &&
          value.departmentId === null &&
          value.workspaceId === null &&
          value.memberId === null
        );
      case 'department.create':
      case 'department.rename':
        return (
          value.organizationId !== null &&
          value.departmentId !== null &&
          value.workspaceId === null &&
          value.memberId === null
        );
      case 'workspace.create':
        return value.organizationId !== null && value.workspaceId !== null && value.memberId === null;
      case 'workspace.update':
        return (
          value.workspaceId !== null &&
          value.memberId === null &&
          (value.organizationId !== null || value.departmentId === null)
        );
      case 'membership.set':
        return value.organizationId !== null && value.workspaceId === null && value.memberId !== null;
    }
  });
export type OrganizationView = z.infer<typeof organizationView>;
export type DepartmentView = z.infer<typeof departmentView>;
export type WorkspaceView = z.infer<typeof workspaceView>;
export type MembershipView = z.infer<typeof membershipView>;
export type DirectoryReceipt = z.infer<typeof directoryReceipt>;
export interface DirectoryPage<T> {
  items: T[];
  next: string | null;
}
/** Host cursors bind these internal positions to actor, filter and operation. */
export const directoryPagePosition = z.strictObject({
  after: directorySubject.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/** Browser pages carry host-signed cursors; database key positions remain internal. */
export const directoryPageRequest = z.strictObject({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const organizationRequest = z.strictObject({ organizationId: id });
export const departmentListRequest = z.strictObject({ ...directoryPageRequest.shape, organizationId: id });
export const workspaceListRequest = z
  .strictObject({ ...directoryPageRequest.shape, organizationId: id.optional(), departmentId: id.optional() })
  .refine((value) => value.departmentId === undefined || value.organizationId !== undefined);
export const workspaceRequest = z.strictObject({ workspaceId: id });
export const membershipListRequest = z.strictObject({
  ...directoryPageRequest.shape,
  organizationId: id,
  departmentId: id.nullable(),
});
const next = z.string().max(2048).nullable();
export const organizationPage = z.strictObject({ items: z.array(organizationView).max(100), next });
export const departmentPage = z.strictObject({ items: z.array(departmentView).max(100), next });
export const workspacePage = z.strictObject({ items: z.array(workspaceView).max(100), next });
export const membershipPage = z.strictObject({ items: z.array(membershipView).max(100), next });
