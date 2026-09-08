import { Injectable, NotFoundException } from '@nestjs/common'; import { InjectModel } from '@nestjs/mongoose'; import { Model, Types } from 'mongoose'; import { Restaurant, RestaurantDocument, RestaurantSettings } from '../common/schemas';
@Injectable() export class RestaurantsService {
  constructor(@InjectModel(Restaurant.name) private readonly restaurants: Model<RestaurantDocument>, @InjectModel(RestaurantSettings.name) private readonly settings: Model<RestaurantSettings>) {}
  async create(input: Pick<Restaurant, 'name' | 'slug' | 'description'>) { const restaurant = await this.restaurants.create(input); await this.settings.create({ restaurantId: restaurant._id }); return restaurant; }
  list() { return this.restaurants.find().sort({ createdAt: -1 }).lean(); }
  async bySlug(slug: string) { const restaurant = await this.restaurants.findOne({ slug, blocked: false }).lean(); if (!restaurant) throw new NotFoundException('Restaurant not found'); return restaurant; }
  async ensureAcceptingOrders(restaurantId: string) { if (!Types.ObjectId.isValid(restaurantId)) throw new NotFoundException('Restaurant not found'); const restaurant = await this.restaurants.findOne({ _id: restaurantId, blocked: false }).lean(); if (!restaurant) throw new NotFoundException('Restaurant not found'); const settings = await this.settings.findOne({ restaurantId }).lean(); return { restaurant, settings }; }
  async update(id: string, input: Partial<Restaurant>) { const restaurant = await this.restaurants.findByIdAndUpdate(id, input, { new: true, runValidators: true }); if (!restaurant) throw new NotFoundException('Restaurant not found'); return restaurant; }
  async updateSettings(id: string, input: Partial<RestaurantSettings>) { const settings = await this.settings.findOneAndUpdate({ restaurantId: id }, input, { new: true, runValidators: true }); if (!settings) throw new NotFoundException('Restaurant settings not found'); return settings; }
}
