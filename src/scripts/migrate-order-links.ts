import { MongoClient, ObjectId } from 'mongodb';

// Idempotent normalization for legacy orders only. It never infers a User from
// phone/CRM data: customerId is converted solely when the stored value already
// contains an unambiguous, valid User ObjectId.
async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const apply = process.argv.includes('--apply');
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db();
    const orders = db.collection('orders');
    const restaurants = db.collection('restaurants');
    const users = db.collection('users');
    const rows = await orders.find({ $or: [{ restaurantId: { $type: 'string' } }, { customerId: { $type: 'string' } }] }, { projection: { restaurantId: 1, customerId: 1 } }).toArray();
    let eligible = 0; let invalid = 0; let updated = 0;
    for (const row of rows) {
      const set: Record<string, ObjectId> = {};
      if (typeof row.restaurantId === 'string' && ObjectId.isValid(row.restaurantId) && await restaurants.findOne({ _id: new ObjectId(row.restaurantId) }, { projection: { _id: 1 } })) set.restaurantId = new ObjectId(row.restaurantId);
      else if (typeof row.restaurantId === 'string') invalid += 1;
      if (typeof row.customerId === 'string' && ObjectId.isValid(row.customerId) && await users.findOne({ _id: new ObjectId(row.customerId), role: 'CUSTOMER' }, { projection: { _id: 1 } })) set.customerId = new ObjectId(row.customerId);
      else if (typeof row.customerId === 'string') invalid += 1;
      if (Object.keys(set).length) { eligible += 1; if (apply) updated += (await orders.updateOne({ _id: row._id }, { $set: set })).modifiedCount; }
    }
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', collection: orders.collectionName, candidates: rows.length, eligible, invalidReferences: invalid, updated }));
  } finally { await client.close(); }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
