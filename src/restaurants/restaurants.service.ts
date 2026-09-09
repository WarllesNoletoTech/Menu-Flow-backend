import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'; import { InjectModel } from '@nestjs/mongoose'; import { Model, Types } from 'mongoose'; import { Restaurant, RestaurantDocument, RestaurantSettings } from '../common/schemas';
import { Role } from '../common/roles';
@Injectable() export class RestaurantsService {
  constructor(@InjectModel(Restaurant.name) private readonly restaurants: Model<RestaurantDocument>, @InjectModel(RestaurantSettings.name) private readonly settings: Model<RestaurantSettings>) {}
  async create(input: Pick<Restaurant, 'name' | 'slug'> & Partial<Pick<Restaurant, 'description' | 'city' | 'state' | 'restaurantCategories'>>) {
    try {
      const restaurant = await this.restaurants.create(input);
      await this.settings.updateOne({ restaurantId: restaurant._id }, { $setOnInsert: { restaurantId: restaurant._id } }, { upsert: true });
      return restaurant;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException('Restaurant slug already exists');
      throw error;
    }
  }
  list() { return this.restaurants.find().sort({ createdAt: -1 }).lean(); }
  async publicCities() {
    return this.restaurants.aggregate<{ city: string; state: string; restaurants: number }>([
      { $match: { blocked: false, city: { $type: 'string', $ne: '' }, state: { $type: 'string', $ne: '' } } },
      { $group: { _id: { city: '$city', state: '$state' }, restaurants: { $sum: 1 } } },
      { $project: { _id: 0, city: '$_id.city', state: '$_id.state', restaurants: 1 } },
      { $sort: { city: 1, state: 1 } },
    ]);
  }
  async publicList(query: { city?: string; state?: string; search?: string; open?: boolean; page: number; limit: number }) {
    const filter: Record<string, unknown> = { blocked: false };
    if (query.city) filter.city = new RegExp(`^${escapeRegExp(query.city.trim())}$`, 'i');
    if (query.state) filter.state = new RegExp(`^${escapeRegExp(query.state.trim())}$`, 'i');
    if (query.open !== undefined) filter.open = query.open;
    if (query.search?.trim()) {
      const search = new RegExp(escapeRegExp(query.search.trim()), 'i');
      filter.$or = [{ name: search }, { tradeName: search }, { description: search }, { restaurantCategories: search }];
    }
    const select = 'name slug tradeName city state logoUrl bannerUrl description restaurantCategories open';
    const [items, total] = await Promise.all([
      this.restaurants.find(filter).select(select).sort({ open: -1, name: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      this.restaurants.countDocuments(filter),
    ]);
    return { items, pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) } };
  }
  async bySlug(slug: string) { const restaurant = await this.restaurants.findOne({ slug, blocked: false }).select('name slug tradeName address city state logoUrl bannerUrl description phone whatsapp instagram restaurantCategories open').lean(); if (!restaurant) throw new NotFoundException('Restaurant not found'); return restaurant; }
  async ensureAcceptingOrders(restaurantId: string) { if (!Types.ObjectId.isValid(restaurantId)) throw new NotFoundException('Restaurant not found'); const restaurant = await this.restaurants.findOne({ _id: restaurantId, blocked: false }).lean(); if (!restaurant) throw new NotFoundException('Restaurant not found'); const settings = await this.settings.findOne({ restaurantId }).lean(); return { restaurant, settings }; }
  async update(id: string, input: Partial<Restaurant>, actorRole: Role) { if (actorRole !== Role.SUPER_ADMIN && input.blocked !== undefined) throw new ForbiddenException('Only platform administrators can change restaurant blocking'); const restaurant = await this.restaurants.findByIdAndUpdate(id, input, { new: true, runValidators: true }); if (!restaurant) throw new NotFoundException('Restaurant not found'); return restaurant; }
  async updateSettings(id: string, input: Partial<RestaurantSettings>) { const settings = await this.settings.findOneAndUpdate({ restaurantId: id }, input, { new: true, runValidators: true }); if (!settings) throw new NotFoundException('Restaurant settings not found'); return settings; }
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
