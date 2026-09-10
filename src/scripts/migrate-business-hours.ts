import 'dotenv/config';
import mongoose, { Types } from 'mongoose';

type SettingsRow = { _id: Types.ObjectId; restaurantId?: unknown };

async function migrate() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error('MONGODB_URI must be configured');
  const apply = process.argv.includes('--apply');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection unavailable');
  const restaurants = db.collection('restaurants');
  const settings = db.collection<SettingsRow>('restaurantsettings');
  const rows = await settings.find({}, { projection: { restaurantId: 1 } }).toArray();
  const canonical = new Map<string, SettingsRow[]>();
  const convertible: Array<{ row: SettingsRow; restaurantId: Types.ObjectId }> = [];
  const invalid: SettingsRow[] = [];

  for (const row of rows) {
    const value = row.restaurantId;
    const objectId = value instanceof Types.ObjectId
      ? value
      : typeof value === 'string' && Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : null;
    if (!objectId || !(await restaurants.findOne({ _id: objectId }, { projection: { _id: 1 } }))) {
      invalid.push(row);
      continue;
    }
    const id = objectId.toHexString();
    canonical.set(id, [...(canonical.get(id) ?? []), row]);
    if (typeof value === 'string') convertible.push({ row, restaurantId: objectId });
  }

  const duplicates = [...canonical.entries()].filter(([, linked]) => linked.length > 1);
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', settings: rows.length, legacyStrings: convertible.length, invalidOrOrphaned: invalid.map((row) => row._id.toHexString()), duplicates: duplicates.map(([restaurantId, linked]) => ({ restaurantId, settingsIds: linked.map((row) => row._id.toHexString()) })) }, null, 2));
  if (invalid.length || duplicates.length) throw new Error('Unsafe legacy RestaurantSettings data found. Review the reported document IDs; no data was deleted or merged.');

  if (!apply) {
    console.log('No changes applied. Re-run with --apply after reviewing this report.');
    return;
  }
  for (const candidate of convertible) await settings.updateOne({ _id: candidate.row._id, restaurantId: candidate.row.restaurantId }, { $set: { restaurantId: candidate.restaurantId } });
  const timezone = await restaurants.updateMany({ $or: [{ timezone: { $exists: false } }, { timezone: '' }] }, { $set: { timezone: 'America/Sao_Paulo' } });
  const hours = await settings.updateMany({ openingHours: { $not: { $type: 'array' } } }, { $set: { openingHours: [] } });
  await settings.createIndex({ restaurantId: 1 }, { unique: true, name: 'restaurantId_1' });
  console.log(JSON.stringify({ legacyStringsConverted: convertible.length, restaurantsUpdated: timezone.modifiedCount, settingsUpdated: hours.modifiedCount, index: 'restaurantId_1' }));
}

void migrate().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
