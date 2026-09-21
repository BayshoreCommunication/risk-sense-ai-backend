/**
 * Provision the four exact public sandbox identities (FR-01, FR-02, SEC-03, SEC-07).
 *
 * All identities live in the existing synthetic PAID `tac` tenant. The operator command refuses
 * tenant, role, email, and Firebase UID ownership conflicts. Public demo access never uses a
 * Firebase password; any legacy matching Firebase identity is disabled and its refresh tokens revoked.
 */
import type { Auth, UserRecord } from 'firebase-admin/auth';
import { connectDb, disconnectDb, withMongoTransaction } from '../lib/db';
import { getFirebaseAuth } from '../lib/firebase';
import { audit } from '../modules/audit/service';
import {
  PUBLIC_DEMO_IDENTITIES,
  PUBLIC_DEMO_TENANT_SLUG,
  type PublicDemoIdentity,
} from '../modules/auth/public-demo';
import { sessionService } from '../modules/auth/service';
import { TenantModel } from '../modules/tenants/model';
import { UserModel } from '../modules/users/model';

export { PUBLIC_DEMO_IDENTITIES, type PublicDemoIdentity } from '../modules/auth/public-demo';
export const PUBLIC_DEMO_TENANT = Object.freeze({ slug: PUBLIC_DEMO_TENANT_SLUG, plan: 'paid' as const });
type IdentifiedRecord = { id: string; email?: string };
type ExistingDemoRecord = IdentifiedRecord & {
  tenantId: string;
  role: string;
  firebaseUid: string;
  status: string;
  publicDemo: boolean;
};

export interface DemoMongoState {
  demoTenant: {
    id: string;
    plan: string;
    publicDemo: boolean;
  } | null;
  emailUser: ExistingDemoRecord | null;
  uidUser?: IdentifiedRecord | null;
}

/** Require the operator to pin provisioning to the reviewed immutable TAC tenant document. */
export function requirePublicDemoTenantId(value: string | undefined): string {
  if (!value) {
    throw new Error('PUBLIC_DEMO_TENANT_ID is required; provisioning will not infer a tenant from its slug');
  }
  if (!/^[a-f\d]{24}$/i.test(value)) {
    throw new Error('PUBLIC_DEMO_TENANT_ID must be an exact 24-character Mongo ObjectId');
  }
  return value.toLowerCase();
}

/** Only Firebase's exact missing-user result is safe to treat as an already-absent credential. */
export function isFirebaseUserNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errorInfo?: { code?: unknown } };
  return candidate.code === 'auth/user-not-found' || candidate.errorInfo?.code === 'auth/user-not-found';
}

/** Guard one fixed identity before changing either Firebase or Mongo. */
export function assertSafeDemoMongoState(
  identity: PublicDemoIdentity,
  state: DemoMongoState,
  expectedTenantId: string,
): void {
  if (!state.demoTenant) {
    throw new Error(
      `configured tenant "${expectedTenantId}" is not the synthetic "${PUBLIC_DEMO_TENANT.slug}" tenant; refusing to provision`,
    );
  }
  if (state.demoTenant.id !== expectedTenantId) {
    throw new Error(`tenant id mismatch for "${PUBLIC_DEMO_TENANT.slug}"; refusing to provision`);
  }
  if (state.demoTenant.plan !== PUBLIC_DEMO_TENANT.plan) {
    throw new Error(
      `tenant "${PUBLIC_DEMO_TENANT.slug}" must have plan "${PUBLIC_DEMO_TENANT.plan}"; found "${state.demoTenant.plan}"`,
    );
  }
  if (state.emailUser && state.emailUser.tenantId !== state.demoTenant.id) {
    throw new Error(`${identity.email} belongs to a different tenant; refusing to move the account`);
  }
  if (state.emailUser && state.emailUser.role !== identity.role) {
    throw new Error(`${identity.email} does not have role "${identity.role}"; refusing to change its role`);
  }
  if (state.uidUser && state.uidUser.id !== state.emailUser?.id) {
    throw new Error(`the Firebase UID for ${identity.email} belongs to another Mongo user; refusing to relink it`);
  }
}

async function findFirebaseUser(auth: Auth, email: string): Promise<UserRecord | null> {
  try {
    return await auth.getUserByEmail(email);
  } catch (error) {
    if (isFirebaseUserNotFound(error)) return null;
    throw error;
  }
}

async function findFirebaseUserByUid(auth: Auth, uid: string): Promise<UserRecord | null> {
  try {
    return await auth.getUser(uid);
  } catch (error) {
    if (isFirebaseUserNotFound(error)) return null;
    throw error;
  }
}

function isPlaceholderFirebaseUid(uid: string | undefined): boolean {
  return !uid || uid.startsWith('dev:') || uid.startsWith('public-demo:');
}

/** Refuse two distinct legacy credentials for one fixed Mongo demo identity. */
export function assertSafeDemoFirebaseState(
  identity: PublicDemoIdentity,
  byEmail: Pick<UserRecord, 'uid' | 'email'> | null,
  byBoundUid: Pick<UserRecord, 'uid' | 'email'> | null,
): void {
  if (byEmail && byEmail.email?.toLowerCase() !== identity.email) {
    throw new Error(`Firebase email lookup for ${identity.email} returned another address; refusing to provision`);
  }
  if (byEmail && byBoundUid && byEmail.uid !== byBoundUid.uid) {
    throw new Error(`multiple Firebase identities resolve to ${identity.email}; refusing ambiguous credential retirement`);
  }
}

export async function disableFirebaseDemoIdentity(auth: Auth, user: UserRecord | null): Promise<'disabled_and_revoked' | 'absent'> {
  if (!user) return 'absent';
  await auth.updateUser(user.uid, { disabled: true });
  await auth.revokeRefreshTokens(user.uid);
  return 'disabled_and_revoked';
}

async function loadMongoState(
  identity: PublicDemoIdentity,
  expectedTenantId: string,
  firebaseUid?: string,
): Promise<DemoMongoState> {
  const [tenant, emailUser, uidUser] = await Promise.all([
    TenantModel.findOne({ _id: expectedTenantId, slug: PUBLIC_DEMO_TENANT.slug })
      .select('_id plan +publicDemo')
      .lean(),
    UserModel.findOne({ email: identity.email })
      .select('_id email tenantId role firebaseUid status +publicDemo')
      .lean(),
    firebaseUid
      ? UserModel.findOne({ firebaseUid }).select('_id email').lean()
      : Promise.resolve(null),
  ]);

  return {
    demoTenant: tenant
      ? {
          id: String(tenant._id),
          plan: tenant.plan,
          publicDemo: tenant.publicDemo,
        }
      : null,
    emailUser: emailUser
      ? {
          id: String(emailUser._id),
          email: emailUser.email,
          tenantId: String(emailUser.tenantId),
          role: emailUser.role,
          firebaseUid: emailUser.firebaseUid,
          status: emailUser.status,
          publicDemo: emailUser.publicDemo,
        }
      : null,
    uidUser: uidUser ? { id: String(uidUser._id), email: uidUser.email } : null,
  };
}

export async function reconcileMongoUser(
  identity: PublicDemoIdentity,
  state: DemoMongoState,
  expectedTenantId: string,
) {
  assertSafeDemoMongoState(identity, state, expectedTenantId);
  const tenant = state.demoTenant;
  if (!tenant) throw new Error('demo tenant validation was not completed');

  if (
    state.emailUser?.status === 'active' &&
    state.emailUser.publicDemo &&
    tenant.publicDemo
  ) {
    // Idempotent reconciliation is also a revocation boundary: a previously issued standard or
    // public-demo session must not survive an operator re-run after credential retirement.
    await sessionService.terminateAllForUser(state.emailUser.id, 'admin');
    return { userId: state.emailUser.id, action: 'unchanged' as const };
  }

  return withMongoTransaction(async () => {
    try {
      const markedTenant = await TenantModel.findOneAndUpdate(
        { _id: tenant.id, slug: PUBLIC_DEMO_TENANT.slug, plan: PUBLIC_DEMO_TENANT.plan },
        {
          $set: { publicDemo: true },
        },
        { new: true },
      ).select('+publicDemo');
      if (!markedTenant) throw new Error('the validated demo tenant changed before provisioning completed');

      const user = await UserModel.findOneAndUpdate(
        {
          email: identity.email,
          tenantId: tenant.id,
          role: identity.role,
        },
        {
          $set: { status: 'active', publicDemo: true },
          $setOnInsert: {
            firebaseUid: `public-demo:${identity.role}`,
            email: identity.email,
            name: identity.name,
            tenantId: tenant.id,
            role: identity.role,
            departmentIds: [],
            crossDepartmentAccess: false,
            mfaEnrolled: false,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
      ).select('+publicDemo');
      const action = state.emailUser ? 'updated' as const : 'created' as const;
      if (state.emailUser) {
        await sessionService.terminateAllForUser(String(user._id), 'admin');
      }
      await audit.write({
        tenantId: tenant.id,
        category: 'config',
        action: action === 'created' ? 'user.provisioned' : 'user.updated',
        actor: null,
        entity: { type: 'user', id: String(user._id) },
        payload: {
          email: identity.email,
          role: identity.role,
          tenant: PUBLIC_DEMO_TENANT.slug,
          status: 'active',
          firebaseAuthentication: 'disabled_or_absent',
          accessMode: 'public_demo_sandbox',
          via: 'scripts/provision-demo-roles',
        },
      });
      return { userId: String(user._id), action };
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new Error(`Mongo identity conflict for ${identity.email}; no other account was modified`);
      }
      throw error;
    }
  });
}

export async function provisionDemoRoles(
  tenantIdValue = process.env.PUBLIC_DEMO_TENANT_ID,
) {
  const expectedTenantId = requirePublicDemoTenantId(tenantIdValue);
  await connectDb();

  try {
    const auth = await getFirebaseAuth();
    const prepared: Array<{ identity: PublicDemoIdentity; firebase: UserRecord | null }> = [];

    // Complete every available ownership check before changing any Firebase credential. Search by
    // both the fixed email and the UID already bound in Mongo so a renamed legacy Firebase account
    // cannot survive migration.
    for (const identity of PUBLIC_DEMO_IDENTITIES) {
      const byEmail = await findFirebaseUser(auth, identity.email);
      const state = await loadMongoState(identity, expectedTenantId, byEmail?.uid);
      assertSafeDemoMongoState(identity, state, expectedTenantId);
      const boundUid = state.emailUser?.firebaseUid;
      const byBoundUid = isPlaceholderFirebaseUid(boundUid)
        ? null
        : await findFirebaseUserByUid(auth, boundUid!);
      assertSafeDemoFirebaseState(identity, byEmail, byBoundUid);
      const firebase = byEmail ?? byBoundUid;
      prepared.push({ identity, firebase });
    }

    const disabled: Array<{
      identity: PublicDemoIdentity;
      firebase: UserRecord | null;
      firebaseAction: 'disabled_and_revoked' | 'absent';
    }> = [];
    for (const { identity, firebase } of prepared) {
      const firebaseAction = await disableFirebaseDemoIdentity(auth, firebase);
      disabled.push({ identity, firebase, firebaseAction });
    }

    // Firebase cannot join the Mongo transaction, so first make every external identity unusable.
    // Only then expose any demo role, and reconcile all four Mongo identities atomically.
    const results = await withMongoTransaction(async () => {
      const reconciled = [];
      for (const { identity, firebase, firebaseAction } of disabled) {
        const finalState = await loadMongoState(identity, expectedTenantId, firebase?.uid);
        assertSafeDemoMongoState(identity, finalState, expectedTenantId);
        const mongo = await reconcileMongoUser(identity, finalState, expectedTenantId);
        reconciled.push({
          email: identity.email,
          tenant: PUBLIC_DEMO_TENANT.slug,
          role: identity.role,
          firebase: firebaseAction,
          mongo: mongo.action,
          userId: mongo.userId,
        });
      }
      return reconciled;
    });

    return { accessMode: 'public_demo_sandbox' as const, identities: results };
  } finally {
    await disconnectDb();
  }
}

if (require.main === module) {
  provisionDemoRoles()
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(`Demo identity provisioning failed: ${(error as Error)?.message ?? 'unknown error'}`);
      process.exitCode = 1;
    });
}
