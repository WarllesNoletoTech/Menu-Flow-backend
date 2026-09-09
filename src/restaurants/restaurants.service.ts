import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { EstablishmentType, Restaurant, RestaurantDocument, RestaurantSettings, User, UserDocument } from '../common/schemas';
import { Role } from '../common/roles';
import { AuthService } from '../auth/auth.service';
import { LocationsService } from '../locations/locations.service';

@Injectable()
export class RestaurantsService {
  constructor(@InjectModel(Restaurant.name) private readonly restaurants: Model<RestaurantDocument>, @InjectModel(RestaurantSettings.name) private readonly settings: Model<RestaurantSettings>, @InjectModel(User.name) private readonly users: Model<UserDocument>, private readonly auth: AuthService, private readonly locations: LocationsService) {}

  async create(input: Pick<Restaurant, 'name' | 'slug'> & Partial<Restaurant>) {
    try {
      const restaurant = await this.restaurants.create(input);
      try { await this.settings.create({ restaurantId: restaurant._id }); }
      catch (error) { await this.restaurants.deleteOne({ _id: restaurant._id }); throw error; }
      return restaurant;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException('Establishment slug already exists');
      throw error;
    }
  }

  async createWithOwner(input: Pick<Restaurant, 'name' | 'slug' | 'city' | 'state' | 'establishmentType'> & Partial<Restaurant>, owner: { name: string; email: string; phone?: string; password: string }) {
    const email = owner.email.trim().toLowerCase();
    input.slug = input.slug.trim().toLowerCase();
    if (!input.name.trim() || !input.establishmentType) throw new BadRequestException('Nome e tipo do estabelecimento são obrigatórios.');
    await this.validateLocation(input.state, input.city);
    if (await this.restaurants.exists({ slug: input.slug })) throw new ConflictException('Já existe um estabelecimento com este slug.');
    if (await this.users.exists({ email })) throw new ConflictException('Já existe um usuário cadastrado com este e-mail.');
    let restaurant: RestaurantDocument | undefined;
    try {
      restaurant = await this.create(input);
      const createdOwner = await this.auth.create(owner.name, email, owner.password, Role.RESTAURANT_ADMIN, restaurant.id, owner.phone);
      return { establishment: publicRestaurant(restaurant), owner: createdOwner };
    } catch (error) {
      if (restaurant) await Promise.all([this.settings.deleteOne({ restaurantId: restaurant._id }), this.restaurants.deleteOne({ _id: restaurant._id })]);
      if (error instanceof ConflictException) {
        const message = (error.getResponse() as { message?: string }).message;
        if (message === 'Email already exists') throw new ConflictException('Já existe um usuário cadastrado com este e-mail.');
      }
      throw error;
    }
  }

  async list(): Promise<Array<Record<string, unknown>>> {
    const fields = 'name slug tradeName cnpj email phone whatsapp instagram address state city description logoUrl bannerUrl establishmentType restaurantCategories open blocked';
    const restaurants = (await this.restaurants.find().select(fields).sort({ createdAt: -1 }).lean()).map(withDefaultType);
    const owners = await this.users.find({ role: Role.RESTAURANT_ADMIN, restaurantId: { $in: restaurants.map((item) => item._id) } }).select('name email restaurantId').sort({ createdAt: 1 }).lean();
    const ownerByRestaurant = new Map(owners.map((owner) => [owner.restaurantId?.toString(), ownerSummary(owner)]));
    return restaurants.map((restaurant) => ({ ...restaurant, owner: ownerByRestaurant.get(restaurant._id.toString()) })) as Array<Record<string, unknown>>;
  }

  async addOwner(restaurantId: string, owner: { name: string; email: string; phone?: string; password: string }) {
    if (!Types.ObjectId.isValid(restaurantId) || !(await this.restaurants.exists({ _id: restaurantId }))) throw new NotFoundException('Estabelecimento não encontrado.');
    try { return await this.auth.create(owner.name, owner.email, owner.password, Role.RESTAURANT_ADMIN, restaurantId, owner.phone); }
    catch (error) { if (error instanceof ConflictException) throw new ConflictException('Já existe um usuário cadastrado com este e-mail.'); throw error; }
  }

  async usersForRestaurant(restaurantId: string) {
    if (!Types.ObjectId.isValid(restaurantId) || !(await this.restaurants.exists({ _id: restaurantId }))) throw new NotFoundException('Estabelecimento não encontrado.');
    return (await this.users.find({ restaurantId, role: { $in: [Role.RESTAURANT_ADMIN, Role.EMPLOYEE] } }).select('name email phone role active').sort({ createdAt: 1 }).lean()).map((user) => ({ id: user._id.toString(), name: user.name, email: user.email, phone: user.phone, role: user.role, active: user.active }));
  }

  publicCities() {
    return this.restaurants.aggregate<{ city: string; state: string; count: number; restaurants: number }>([
      { $match: { blocked: false, city: { $type: 'string', $ne: '' }, state: { $type: 'string', $ne: '' } } },
      { $group: { _id: { city: '$city', state: '$state' }, count: { $sum: 1 } } },
      { $project: { _id: 0, city: '$_id.city', state: '$_id.state', count: 1, restaurants: '$count' } },
      { $sort: { city: 1, state: 1 } },
    ]);
  }

  async publicList(query: { city?: string; state?: string; search?: string; type?: EstablishmentType; open?: boolean; page: number; limit: number }) {
    const filter: FilterQuery<RestaurantDocument> = { blocked: false };
    if (query.city) filter.city = new RegExp(`^${escapeRegExp(query.city.trim())}$`, 'i');
    if (query.state) filter.state = new RegExp(`^${escapeRegExp(query.state.trim())}$`, 'i');
    if (query.open !== undefined) filter.open = query.open;
    if (query.type === EstablishmentType.RESTAURANT) filter.$and = [{ $or: [{ establishmentType: EstablishmentType.RESTAURANT }, { establishmentType: { $exists: false } }] }];
    else if (query.type) filter.establishmentType = query.type;
    if (query.search?.trim()) {
      const search = new RegExp(escapeRegExp(query.search.trim()), 'i');
      const inferredType = typeForSearch(query.search);
      filter.$or = [{ name: search }, { tradeName: search }, { description: search }, { restaurantCategories: search }, ...(inferredType ? [{ establishmentType: inferredType }] : [])];
    }
    const select = 'name slug tradeName city state logoUrl bannerUrl description establishmentType restaurantCategories open';
    const [items, total] = await Promise.all([
      this.restaurants.find(filter).select(select).sort({ open: -1, name: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      this.restaurants.countDocuments(filter),
    ]);
    return { items: items.map(withDefaultType), pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) } };
  }

  async bySlug(slug: string) { const restaurant = await this.restaurants.findOne({ slug, blocked: false }).select('name slug tradeName address city state logoUrl bannerUrl description phone whatsapp instagram establishmentType restaurantCategories open').lean(); if (!restaurant) throw new NotFoundException('Establishment not found'); return withDefaultType(restaurant); }
  async ensureAcceptingOrders(restaurantId: string) { if (!Types.ObjectId.isValid(restaurantId)) throw new NotFoundException('Restaurant not found'); const restaurant = await this.restaurants.findOne({ _id: restaurantId, blocked: false }).lean(); if (!restaurant) throw new NotFoundException('Restaurant not found'); const settings = await this.settings.findOne({ restaurantId }).lean(); return { restaurant, settings }; }
  async update(id: string, input: Partial<Restaurant>, actorRole: Role) { if (actorRole !== Role.SUPER_ADMIN && input.blocked !== undefined) throw new ForbiddenException('Only platform administrators can change establishment blocking'); const restaurant = await this.restaurants.findByIdAndUpdate(id, input, { new: true, runValidators: true }); if (!restaurant) throw new NotFoundException('Establishment not found'); return restaurant; }
  async updateSettings(id: string, input: Partial<RestaurantSettings>) { const settings = await this.settings.findOneAndUpdate({ restaurantId: id }, input, { new: true, runValidators: true }); if (!settings) throw new NotFoundException('Restaurant settings not found'); return settings; }

  private async validateLocation(state?: string, city?: string) {
    if (!state || !city) throw new BadRequestException('Estado e cidade válidos são obrigatórios.');
    const cities = await this.locations.cities(state);
    if (!cities.some((candidate) => candidate.name === city.trim())) throw new BadRequestException('A cidade não pertence ao estado selecionado.');
  }
}

function publicRestaurant(restaurant: RestaurantDocument) { return { id: restaurant.id, name: restaurant.name, slug: restaurant.slug, city: restaurant.city, state: restaurant.state, establishmentType: restaurant.establishmentType }; }
function ownerSummary(owner: { _id: Types.ObjectId; name: string; email: string }) { return { id: owner._id.toString(), name: owner.name, email: owner.email }; }

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function withDefaultType<T extends { establishmentType?: EstablishmentType }>(item: T): T & { establishmentType: EstablishmentType } { return { ...item, establishmentType: item.establishmentType ?? EstablishmentType.RESTAURANT }; }
function typeForSearch(value: string) { const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); if (/farmacia/.test(normalized)) return EstablishmentType.PHARMACY; if (/roupa|vestuario/.test(normalized)) return EstablishmentType.CLOTHING; if (/restaurante/.test(normalized)) return EstablishmentType.RESTAURANT; return undefined; }
