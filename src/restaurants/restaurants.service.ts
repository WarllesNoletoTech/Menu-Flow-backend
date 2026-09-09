import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'; import { InjectModel } from '@nestjs/mongoose'; import { Model, Types } from 'mongoose'; import { Restaurant, RestaurantDocument, RestaurantSettings } from '../common/schemas';
import { Role } from '../common/roles';
@Injectable() export class RestaurantsService {
  constructor(@InjectModel(Restaurant.name) private readonly restaurants: Model<RestaurantDocument>, @InjectModel(RestaurantSettings.name) private readonly settings: Model<RestaurantSettings>) {}
  async create(input: Pick<Restaurant, 'name' | 'slug' | 'description'>) {
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
  async bySlug(slug: string) { const restaurant = await this.restaurants.findOne({ slug, blocked: false }).lean(); if (!restaurant) throw new NotFoundException('Restaurant not found'); return restaurant; }
  async ensureAcceptingOrders(restaurantId: string) { if (!Types.ObjectId.isValid(restaurantId)) throw new NotFoundException('Restaurant not found'); const restaurant = await this.restaurants.findOne({ _id: restaurantId, blocked: false }).lean(); if (!restaurant) throw new NotFoundException('Restaurant not found'); const settings = await this.settings.findOne({ restaurantId }).lean(); return { restaurant, settings }; }
  async update(id: string, input: Partial<Restaurant>, actorRole: Role) { if (actorRole !== Role.SUPER_ADMIN && input.blocked !== undefined) throw new ForbiddenException('Only platform administrators can change restaurant blocking'); const restaurant = await this.restaurants.findByIdAndUpdate(id, input, { new: true, runValidators: true }); if (!restaurant) throw new NotFoundException('Restaurant not found'); return restaurant; }
  async updateSettings(id: string, input: Partial<RestaurantSettings>) { const settings = await this.settings.findOneAndUpdate({ restaurantId: id }, input, { new: true, runValidators: true }); if (!settings) throw new NotFoundException('Restaurant settings not found'); return settings; }
}
