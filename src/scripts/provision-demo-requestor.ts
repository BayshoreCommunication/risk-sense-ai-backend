/**
 * Provision the one shared FREE password demo identity (FR-01, SEC-03, FR-25, SEC-07).
 *
 * This operator command is deliberately narrow: it never creates a tenant or role, and it refuses
 * to move/demote an existing account. The target Firebase project and Mongo database come from the
 * backend's ordinary environment configuration.
 */
import type { Auth, UserRecord } from 'firebase-admin/auth';
import { connectDb, disconnectDb, withMongoTransaction } from '../lib/db';
import { getFirebaseAuth } from '../lib/firebase';
import { audit } from '../modules/audit/service';
import { PUBLIC_TENANT_SLUG, TenantModel } from '../modules/tenants/model';
import { UserModel } from '../modules/users/model';

export const DEMO_REQUESTOR = Object.freeze({
  email: 'requestor@dev.local',
  name: 'Dev Requestor',
  role: 'requestor' as const,
  tenantSlug: PUBLIC_TENANT_SLUG,
});

type IdentifiedRecord = { id: string; email?: string };
type ExistingDemoRecord = IdentifiedRecord & {
  tenantId: string;
  role: string;
  firebaseUid: string;
  status: string;
};

export interface DemoMongoState {
  publicTenant: { id: string; plan: string } | null;
  emailUser: ExistingDemoRecord | null;
  uidUser?: IdentifiedRecord | null;
}

/** Fail before contacting Firebase when the required operator secret is absent or unusable. */
export function requireDemoUserPassword(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error('DEMO_USER_PASSWORD is required (see .env.example); no default is provided');
  }
  if (value.length < 8 || value.trim().length === 0) {
    throw new Error('DEMO_USER_PASSWORD must be at least 8 characters and not be blank');
  }
  return value;
}

/** Only Firebase's exact missing-user result is safe to turn into account creation. */
export function isFirebaseUserNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errorInfo?: { code?: unknown } };
  return candidate.code === 'auth/user-not-found' || candidate.errorInfo?.code === 'auth/user-not-found';
}

/**
 * Guard the fixed Mongo target. A mismatched tenant, role, or UID owner is another account and must
 * be left untouched; the operator must resolve that conflict explicitly instead of this script guessing.
 */
export function assertSafeDemoMongoState(state: DemoMongoState): void {
  if (!state.publicTenant) {
    throw new Error(`tenant "${DEMO_REQUESTOR.tenantSlug}" is missing; run the approved tenant seed first`);
  }
  if (state.publicTenant.plan !== 'free') {
    throw new Error(`tenant "${DEMO_REQUESTOR.tenantSlug}" must have plan "free"; found "${state.publicTenant.plan}"`);
  }
  if (state.emailUser && state.emailUser.tenantId !== state.publicTenant.id) {
    throw new Error(`${DEMO_REQUESTOR.email} belongs to a different tenant; refusing to move the account`);
  }
  if (state.emailUser && state.emailUser.role !== DEMO_REQUESTOR.role) {
    throw new Error(`${DEMO_REQUESTOR.email} is not a requestor; refusing to change its role`);
  }
  if (state.uidUser && state.uidUser.id !== state.emailUser?.id) {
    throw new Error(`the Firebase UID for ${DEMO_REQUESTOR.email} belongs to another Mongo user; refusing to relink it`);
  }
}

async function findFirebaseUser(auth: Auth): Promise<UserRecord | null> {
  try {
    return await auth.getUserByEmail(DEMO_REQUESTOR.email);
  } catch (error) {
    if (isFirebaseUserNotFound(error)) return null;
    throw error;
  }
}

async function loadMongoState(firebaseUid?: string): Promise<DemoMongoState> {
  const [tenant, emailUser, uidUser] = await Promise.all([
    TenantModel.findOne({ slug: DEMO_REQUESTOR.tenantSlug }).select('_id plan').lean(),
    UserModel.findOne({ email: DEMO_REQUESTOR.email }).select('_id email tenantId role firebaseUid status').lean(),
    firebaseUid
      ? UserModel.findOne({ firebaseUid }).select('_id email').lean()
      : Promise.resolve(null),
  ]);

  return {
    publicTenant: tenant ? { id: String(tenant._id), plan: tenant.plan } : null,
    emailUser: emailUser
      ? {
          id: String(emailUser._id),
          email: emailUser.email,
          tenantId: String(emailUser.tenantId),
          role: emailUser.role,
          firebaseUid: emailUser.firebaseUid,
          status: emailUser.status,
        }
      : null,
    uidUser: uidUser ? { id: String(uidUser._id), email: uidUser.email } : null,
  };
}

export async function reconcileMongoUser(state: DemoMongoState, firebaseUid: string) {
  assertSafeDemoMongoState(state);
  const tenant = state.publicTenant;
  if (!tenant) throw new Error('public tenant validation was not completed');

  if (state.emailUser?.firebaseUid === firebaseUid && state.emailUser.status === 'active') {
    return { userId: state.emailUser.id, action: 'unchanged' as const };
  }

  return withMongoTransaction(async () => {
    try {
      const user = await UserModel.findOneAndUpdate(
        {
          email: DEMO_REQUESTOR.email,
          tenantId: tenant.id,
          role: DEMO_REQUESTOR.role,
        },
        {
          $set: { firebaseUid, status: 'active' },
          $setOnInsert: {
            email: DEMO_REQUESTOR.email,
            name: DEMO_REQUESTOR.name,
            tenantId: tenant.id,
            role: DEMO_REQUESTOR.role,
            departmentIds: [],
            crossDepartmentAccess: false,
            mfaEnrolled: false,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
      );
      const action = state.emailUser ? 'updated' as const : 'created' as const;
      await audit.write({
        tenantId: tenant.id,
        category: 'config',
        action: action === 'created' ? 'user.provisioned' : 'user.updated',
        actor: null,
        entity: { type: 'user', id: String(user._id) },
        payload: {
          email: DEMO_REQUESTOR.email,
          role: DEMO_REQUESTOR.role,
          tenant: DEMO_REQUESTOR.tenantSlug,
          status: 'active',
          identityLinked: true,
          via: 'scripts/provision-demo-requestor',
        },
      });
      return { userId: String(user._id), action };
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new Error(`Mongo identity conflict for ${DEMO_REQUESTOR.email}; no other account was modified`);
      }
      throw error;
    }
  });
}

export async function provisionDemoRequestor(passwordValue = process.env.DEMO_USER_PASSWORD) {
  const password = requireDemoUserPassword(passwordValue);
  await connectDb();

  try {
    const initialState = await loadMongoState();
    assertSafeDemoMongoState(initialState);

    const auth = await getFirebaseAuth();
    const existingFirebaseUser = await findFirebaseUser(auth);
    if (existingFirebaseUser) {
      const stateWithUid = await loadMongoState(existingFirebaseUser.uid);
      assertSafeDemoMongoState(stateWithUid);
    }

    const firebaseUser = existingFirebaseUser
      ? await auth.updateUser(existingFirebaseUser.uid, {
          email: DEMO_REQUESTOR.email,
          password,
          displayName: DEMO_REQUESTOR.name,
          emailVerified: true,
          disabled: false,
        })
      : await auth.createUser({
          email: DEMO_REQUESTOR.email,
          password,
          displayName: DEMO_REQUESTOR.name,
          emailVerified: true,
          disabled: false,
        });

    const finalState = await loadMongoState(firebaseUser.uid);
    assertSafeDemoMongoState(finalState);
    const mongo = await reconcileMongoUser(finalState, firebaseUser.uid);

    return {
      email: DEMO_REQUESTOR.email,
      tenant: DEMO_REQUESTOR.tenantSlug,
      role: DEMO_REQUESTOR.role,
      firebase: existingFirebaseUser ? 'updated' as const : 'created' as const,
      mongo: mongo.action,
      userId: mongo.userId,
    };
  } finally {
    await disconnectDb();
  }
}

if (require.main === module) {
  provisionDemoRequestor()
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      const secret = process.env.DEMO_USER_PASSWORD;
      const rawMessage = (error as Error)?.message ?? 'unknown error';
      const safeMessage = secret ? rawMessage.split(secret).join('[REDACTED]') : rawMessage;
      console.error(`Demo identity provisioning failed: ${safeMessage}`);
      process.exitCode = 1;
    });
}
