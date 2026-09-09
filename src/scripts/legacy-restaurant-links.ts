import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { Role } from '../common/roles';

export const membershipRoles = [Role.RESTAURANT_ADMIN, Role.EMPLOYEE] as const;

export type RawUser = {
  _id: Types.ObjectId;
  name?: unknown;
  email?: unknown;
  role?: unknown;
  restaurantId?: unknown;
  deletedAt?: unknown;
};

export type RawRestaurant = { _id: Types.ObjectId; name?: unknown; tradeName?: unknown };

export async function openLegacyCollections() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error('MONGODB_URI deve estar configurada.');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  return {
    users: mongoose.connection.collection<RawUser>('users'),
    restaurants: mongoose.connection.collection<RawRestaurant>('restaurants'),
  };
}

export async function closeLegacyConnection() {
  await mongoose.disconnect();
}

export function bsonType(value: unknown, present = true) {
  if (!present) return 'missing';
  if (value === null) return 'null';
  if (value instanceof Types.ObjectId) return 'objectId';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  return typeof value;
}

export function rawValue(value: unknown, present = true) {
  if (!present) return '(ausente)';
  if (value instanceof Types.ObjectId) return `ObjectId("${value.toHexString()}")`;
  return JSON.stringify(value);
}

export function normalizedRestaurantObjectId(value: unknown) {
  if (value instanceof Types.ObjectId) return value;
  if (typeof value === 'string' && Types.ObjectId.isValid(value) && new Types.ObjectId(value).toHexString() === value.toLowerCase()) {
    return new Types.ObjectId(value);
  }
  return null;
}

export function restaurantLabel(restaurant?: RawRestaurant) {
  if (!restaurant) return 'NÃO';
  const label = typeof restaurant.tradeName === 'string' && restaurant.tradeName.trim()
    ? restaurant.tradeName
    : restaurant.name;
  return typeof label === 'string' ? label : restaurant._id.toHexString();
}

export function safeText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : '—';
}
