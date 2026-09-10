import mongoose, { Types } from 'mongoose';
import { normalizeTypeName, typeSlug } from '../establishment-types/establishment-types.service';

const legacyNames: Record<string, string> = { RESTAURANT: 'Restaurante', STORE: 'Loja', PHARMACY: 'Farmácia', CLOTHING: 'Loja de roupas', OTHER: 'Loja' };

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const apply = process.argv.includes('--apply');
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  const restaurants = db.collection('restaurants');
  const types = db.collection('establishmenttypedefinitions');
  const creator = await db.collection('users').findOne({ role: 'SUPER_ADMIN' }, { projection: { _id: 1 } });
  if (!creator && apply) throw new Error('A SUPER_ADMIN is required to attribute migrated types.');
  const legacyValues = await restaurants.distinct('establishmentType');
  if (await restaurants.countDocuments({ establishmentType: { $exists: false } })) legacyValues.push('RESTAURANT');
  const names = [...new Set(legacyValues.map(value => legacyNames[String(value)] ?? String(value).trim()).filter(Boolean))];
  console.log(`${apply ? 'Migrating' : 'Would migrate'} ${names.length} establishment type(s): ${names.join(', ')}`);
  if (apply) {
    for (const name of names) {
      const normalizedName = normalizeTypeName(name); const slug = typeSlug(name);
      const result = await types.findOneAndUpdate({ normalizedName }, { $setOnInsert: { name, normalizedName, slug, active: true, sortOrder: 0, createdBy: creator!._id, createdAt: new Date(), updatedAt: new Date() } }, { upsert: true, returnDocument: 'after' });
      const legacyKeys = Object.entries(legacyNames).filter(([, label]) => normalizeTypeName(label) === normalizedName).map(([key]) => key);
      await restaurants.updateMany({ establishmentTypeId: { $exists: false }, $or: [{ establishmentType: { $in: legacyKeys } }, { establishmentType: name }, ...(legacyKeys.includes('RESTAURANT') ? [{ establishmentType: { $exists: false } }] : [])] }, { $set: { establishmentTypeId: new Types.ObjectId(result!._id) } });
    }
    await types.createIndex({ slug: 1 }, { unique: true });
    await types.createIndex({ normalizedName: 1 }, { unique: true });
  }
  await mongoose.disconnect();
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
