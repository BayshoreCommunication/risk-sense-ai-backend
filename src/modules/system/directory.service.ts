import { Types } from 'mongoose';
import { withMongoTransaction } from '../../lib/db';
import { AppError, notFound } from '../../lib/errors';
import type { AuthUser } from '../../middleware/auth';
import { audit } from '../audit/service';
import { sessionService } from '../auth/service';
import { PersonaModel } from '../personas/model';
import { DepartmentModel, PUBLIC_TENANT_SLUG, TenantModel } from '../tenants/model';
import { UserModel } from '../users/model';
import type { SystemDepartmentCreate, SystemDepartmentPatch, SystemUserCreate, SystemUserPatch } from './schema';
import { contentTenantId } from '../assessments/content';

const userView = (user: InstanceType<typeof UserModel>) => ({
  _id: String(user._id),
  email: user.email,
  name: user.name,
  role: user.role,
  departmentIds: user.departmentIds.map(String),
  crossDepartmentAccess: user.crossDepartmentAccess,
  mfaEnrolled: user.mfaEnrolled,
  status: user.status,
  lastLoginAt: user.lastLoginAt ?? null,
});

const departmentView = (department: InstanceType<typeof DepartmentModel>) => ({
  _id: String(department._id),
  name: department.name,
  personaIds: department.personaIds.map(String),
});

async function validateDepartments(tenantId: string, departmentIds: string[]) {
  const unique = [...new Set(departmentIds)];
  const count = await DepartmentModel.countDocuments({ tenantId, _id: { $in: unique.map((id) => new Types.ObjectId(id)) } });
  if (count !== unique.length) throw new AppError('VALIDATION_ERROR', 'Every department must belong to this tenant');
  return unique;
}

async function validatePersonas(tenantId: string, personaIds: string[]) {
  const unique = [...new Set(personaIds)];
  if (unique.length === 0) return unique;
  const publicTenant = await TenantModel.findOne({ slug: PUBLIC_TENANT_SLUG }).select('_id').lean();
  const allowedTenants = [new Types.ObjectId(tenantId), ...(publicTenant ? [publicTenant._id] : [])];
  const count = await PersonaModel.countDocuments({
    _id: { $in: unique.map((id) => new Types.ObjectId(id)) },
    tenantId: { $in: allowedTenants },
    status: 'active',
    isCurrent: true,
  });
  if (count !== unique.length) throw new AppError('VALIDATION_ERROR', 'Every mapped persona must be an active tenant or shared persona');
  return unique;
}

function validateRoleScope(role: string, departmentIds: string[], crossDepartmentAccess: boolean) {
  if (role !== 'requestor' && (departmentIds.length > 0 || crossDepartmentAccess)) {
    throw new AppError('VALIDATION_ERROR', 'Department scope is only valid for requestors');
  }
}

export const directoryService = {
  async personas(tenantId: string) {
    const effectiveTenantId = await contentTenantId(tenantId);
    const personas = await PersonaModel.find({ tenantId: effectiveTenantId, status: 'active', isCurrent: true })
      .sort({ name: 1, key: 1 })
      .select('key name sector')
      .lean();
    return personas.map((persona) => ({
      _id: String(persona._id),
      key: persona.key,
      name: persona.name,
      sector: persona.sector,
      source: effectiveTenantId === tenantId ? 'tenant' : 'shared',
    }));
  },

  async users(tenantId: string) {
    const users = await UserModel.find({ tenantId }).sort({ name: 1, email: 1 });
    return users.map(userView);
  },

  async createUser(tenantId: string, body: SystemUserCreate, actor: AuthUser) {
    const departmentIds = await validateDepartments(tenantId, body.departmentIds);
    validateRoleScope(body.role, departmentIds, body.crossDepartmentAccess);
    let user;
    try {
      user = await UserModel.create({
        firebaseUid: `dev:${body.email}`,
        email: body.email,
        name: body.name,
        role: body.role,
        tenantId,
        departmentIds,
        crossDepartmentAccess: body.crossDepartmentAccess,
        mfaEnrolled: false,
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new AppError('CONFLICT', 'A user with this email already exists');
      throw error;
    }
    await audit.write({ tenantId, category: 'config', action: 'user.created', actor, entity: { type: 'user', id: String(user._id) }, payload: userView(user) });
    return userView(user);
  },

  async updateUser(tenantId: string, id: string, body: SystemUserPatch, actor: AuthUser) {
    return withMongoTransaction(async () => {
      const user = await UserModel.findOne({ _id: id, tenantId });
      if (!user) throw notFound('user');
      if (actor.id === id && ((body.role && body.role !== user.role) || body.status === 'disabled')) {
        throw new AppError('FORBIDDEN', 'You cannot demote or disable your current account');
      }
      const before = userView(user);
      const role = body.role ?? user.role;
      const departmentIds = body.departmentIds ? await validateDepartments(tenantId, body.departmentIds) : user.departmentIds.map(String);
      const crossDepartmentAccess = body.crossDepartmentAccess ?? user.crossDepartmentAccess;
      validateRoleScope(role, departmentIds, crossDepartmentAccess);
      if (body.name) user.name = body.name;
      if (body.role) user.role = body.role;
      if (body.departmentIds) user.departmentIds = departmentIds.map((departmentId) => new Types.ObjectId(departmentId));
      if (body.crossDepartmentAccess !== undefined) user.crossDepartmentAccess = body.crossDepartmentAccess;
      if (body.status) user.status = body.status;
      await user.save();
      const roleOrStatusChanged = before.role !== user.role || before.status !== user.status;
      if (roleOrStatusChanged) await sessionService.terminateAllForUser(id, before.role !== user.role ? 'role_changed' : 'admin', actor);
      const after = userView(user);
      await audit.write({ tenantId, category: 'config', action: 'user.updated', actor, entity: { type: 'user', id }, payload: { before, after, changed: Object.keys(body) } });
      return after;
    });
  },

  async departments(tenantId: string) {
    const departments = await DepartmentModel.find({ tenantId }).sort({ name: 1 });
    return departments.map(departmentView);
  },

  async createDepartment(tenantId: string, body: SystemDepartmentCreate, actor: AuthUser) {
    const personaIds = await validatePersonas(tenantId, body.personaIds);
    let department;
    try {
      department = await DepartmentModel.create({ tenantId, name: body.name, personaIds });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new AppError('CONFLICT', 'A department with this name already exists');
      throw error;
    }
    await audit.write({ tenantId, category: 'config', action: 'department.created', actor, entity: { type: 'department', id: String(department._id) }, payload: departmentView(department) });
    return departmentView(department);
  },

  async updateDepartment(tenantId: string, id: string, body: SystemDepartmentPatch, actor: AuthUser) {
    const department = await DepartmentModel.findOne({ _id: id, tenantId });
    if (!department) throw notFound('department');
    const before = departmentView(department);
    if (body.name) department.name = body.name;
    if (body.personaIds) department.personaIds = (await validatePersonas(tenantId, body.personaIds)).map((personaId) => new Types.ObjectId(personaId));
    try {
      await department.save();
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new AppError('CONFLICT', 'A department with this name already exists');
      throw error;
    }
    const after = departmentView(department);
    await audit.write({ tenantId, category: 'config', action: 'department.updated', actor, entity: { type: 'department', id }, payload: { before, after, changed: Object.keys(body) } });
    return after;
  },
};
