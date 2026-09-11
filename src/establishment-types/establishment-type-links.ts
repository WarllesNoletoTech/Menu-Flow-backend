import { Types } from 'mongoose';

/** Returns the same identifier as BSON ObjectId only when the legacy string is valid. */
export function legacyStringToObjectId(value: unknown): Types.ObjectId | undefined {
  return typeof value === 'string' && Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : undefined;
}
