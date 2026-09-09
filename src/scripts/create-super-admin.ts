import * as bcrypt from 'bcrypt';
import { createConnection, Model } from 'mongoose';
import { Role } from '../common/roles';
import { User, UserSchema } from '../common/schemas';

const BCRYPT_ROUNDS = 12;

type AdminInput = {
  name: string;
  email: string;
  password: string;
};

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') throw new Error(`${name} must be configured.`);
  return value;
}

function readAdminInput(): AdminInput {
  const name = requiredEnvironmentVariable('SUPER_ADMIN_NAME').trim();
  const email = requiredEnvironmentVariable('SUPER_ADMIN_EMAIL').trim().toLowerCase();
  const password = requiredEnvironmentVariable('SUPER_ADMIN_PASSWORD');

  if (password.length < 8) {
    throw new Error('SUPER_ADMIN_PASSWORD must contain at least 8 characters.');
  }

  return { name, email, password };
}

async function createSuperAdmin(users: Model<User>, input: AdminInput): Promise<string> {
  if (await users.exists({ email: input.email })) {
    throw new Error(`A user with email ${input.email} already exists; no changes were made.`);
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  try {
    const user = await users.create({
      name: input.name,
      email: input.email,
      passwordHash,
      role: Role.SUPER_ADMIN,
      active: true,
    });
    return user.id;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      throw new Error(`A user with email ${input.email} already exists; no changes were made.`);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  let input: AdminInput;
  let mongoUri: string;

  try {
    input = readAdminInput();
    mongoUri = requiredEnvironmentVariable('MONGODB_URI');
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : 'Invalid administrative account configuration.');
    process.exitCode = 1;
    return;
  }

  const connection = createConnection(mongoUri, { serverSelectionTimeoutMS: 10000 });

  try {
    await connection.asPromise();
    const users = connection.model<User>(User.name, UserSchema);
    const userId = await createSuperAdmin(users, input);
    console.log(`SUPER_ADMIN created successfully (id: ${userId}, email: ${input.email}).`);
  } catch (error: unknown) {
    const safeMessage = error instanceof Error && error.message.includes('no changes were made')
      ? error.message
      : 'Could not create SUPER_ADMIN. Verify the database connection and configuration.';
    console.error(safeMessage);
    process.exitCode = 1;
  } finally {
    await connection.close().catch(() => undefined);
  }
}

void main();
