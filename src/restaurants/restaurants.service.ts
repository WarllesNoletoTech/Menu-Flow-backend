import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { AuditLog, BusinessDay, DeliveryZone, EstablishmentType, Payment, Restaurant, RestaurantDocument, RestaurantSettings, User, UserDocument } from '../common/schemas';
import { Role } from '../common/roles';
import { AuthService } from '../auth/auth.service';
import { LocationsService } from '../locations/locations.service';
import { canAcceptOrdersNow, DEFAULT_TIMEZONE, openingStatus, validateBusinessHours } from './business-hours';
import { normalizeBrazilianWhatsApp } from '../orders/order-whatsapp';
import { normalizeReportWhatsapp } from '../users/report-whatsapp';
import { MENU_FLOW_ORDER_SERVICE_FEE_CENTS } from '../billing/billing-rules';

@Injectable()
export class RestaurantsService {
  private readonly logger = new Logger(RestaurantsService.name);
  constructor(@InjectModel(Restaurant.name) private readonly restaurants: Model<RestaurantDocument>, @InjectModel(RestaurantSettings.name) private readonly settings: Model<RestaurantSettings>, @InjectModel(User.name) private readonly users: Model<UserDocument>, @InjectModel(AuditLog.name) private readonly audits: Model<AuditLog>, @InjectModel(DeliveryZone.name) private readonly deliveryZones: Model<DeliveryZone>, @InjectModel(Payment.name) private readonly payments: Model<Payment>, private readonly auth: AuthService, private readonly locations: LocationsService) {}

  async create(input: Pick<Restaurant, 'name' | 'slug'> & Partial<Restaurant>) {
    try {
      input.orderWhatsapp = normalizeBrazilianWhatsApp(input.orderWhatsapp);
      const restaurant = await this.restaurants.create(input);
      try { await this.settings.create({ restaurantId: restaurant._id }); }
      catch (error) { await this.restaurants.deleteOne({ _id: restaurant._id }); throw error; }
      return restaurant;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException('Establishment slug already exists');
      throw error;
    }
  }

  async createWithOwner(input: Pick<Restaurant, 'name' | 'slug' | 'city' | 'state' | 'establishmentType'> & Partial<Restaurant>, owner: { name: string; email: string; phone?: string; reportWhatsapp: string; password: string }) {
    const email = owner.email.trim().toLowerCase();
    input.slug = input.slug.trim().toLowerCase();
    if (!input.name.trim() || !input.establishmentType) throw new BadRequestException('Nome e tipo do estabelecimento são obrigatórios.');
    await this.validateLocation(input.state, input.city);
    if (await this.restaurants.exists({ slug: input.slug })) throw new ConflictException('Já existe um estabelecimento com este slug.');
    if (await this.users.exists({ email })) throw new ConflictException('Já existe um usuário cadastrado com este e-mail.');
    let restaurant: RestaurantDocument | undefined;
    let createdOwnerId: string | undefined;
    try {
      restaurant = await this.create(input);
      const createdOwner = await this.auth.create(owner.name, email, owner.password, Role.RESTAURANT_ADMIN, restaurant.id, owner.phone, owner.reportWhatsapp);
      createdOwnerId = createdOwner.id;
      const linkedOwner = await this.users.exists({ _id: createdOwner.id, role: Role.RESTAURANT_ADMIN, restaurantId: restaurant._id });
      if (!linkedOwner) throw new BadRequestException('Não foi possível confirmar o vínculo do lojista ao estabelecimento.');
      return { establishment: publicRestaurant(restaurant), owner: createdOwner };
    } catch (error) {
      // Compensating rollback is intentionally scoped to documents created by this operation.
      // It works on standalone MongoDB as well as Atlas and never removes pre-existing data.
      if (createdOwnerId) await this.users.deleteOne({ _id: createdOwnerId });
      if (restaurant) await Promise.all([this.settings.deleteOne({ restaurantId: restaurant._id }), this.restaurants.deleteOne({ _id: restaurant._id })]);
      if (error instanceof ConflictException) {
        const message = (error.getResponse() as { message?: string }).message;
        if (message === 'Email already exists') throw new ConflictException('Já existe um usuário cadastrado com este e-mail.');
      }
      throw error;
    }
  }

  async adminDetail(restaurantId: string) {
    await this.ensureRestaurant(restaurantId);
    const rid = new Types.ObjectId(restaurantId);
    const [establishment, users, settings, deliveryZones, paymentMethods] = await Promise.all([
      this.restaurants.findById(rid).select('-__v').lean(),
      this.users.find({ restaurantId: rid, role: { $in: [Role.RESTAURANT_ADMIN, Role.EMPLOYEE] }, deletedAt: null }).select('name email phone reportWhatsapp role active restaurantId').sort({ createdAt: 1 }).lean(),
      this.settings.findOne({ restaurantId: rid }).select('-__v').lean(),
      this.deliveryZones.find({ restaurantId: rid }).sort({ name: 1 }).lean(),
      this.payments.find({ restaurantId: rid }).sort({ method: 1 }).lean(),
    ]);
    const summaries = users.map(storeUserSummary);
    return { establishment: withDefaultType(establishment!), owner: summaries.find((user) => user.role === Role.RESTAURANT_ADMIN) ?? null, users: summaries, settings, deliveryZones, paymentMethods };
  }

  async ownerDetail(restaurantId: string): Promise<Record<string, unknown>> {
    await this.ensureRestaurant(restaurantId);
    const [establishment, settings, deliveryZones, paymentMethods] = await Promise.all([
      this.restaurants.findById(restaurantId).select('-__v').lean(),
      this.settings.findOne({ restaurantId }).select('-__v').lean(),
      this.deliveryZones.find({ restaurantId }).sort({ name: 1 }).lean(),
      this.payments.find({ restaurantId }).sort({ method: 1 }).lean(),
    ]);
    const availability = canAcceptOrdersNow({
      blocked: establishment!.blocked,
      acceptingOrders: establishment!.open,
      openingHours: settings?.openingHours ?? [],
      timezone: establishment!.timezone,
    });
    return { establishment: { ...withDefaultType(establishment!), ...availability }, settings, deliveryZones, paymentMethods };
  }

  async memberContext(restaurantId: string) {
    await this.ensureRestaurant(restaurantId);
    const establishment = await this.restaurants.findById(restaurantId).select('name tradeName slug open').lean();
    return { establishment };
  }

  async updateWithOwner(restaurantId: string, establishment: Partial<Restaurant>, owner?: { userId: string; name?: string; email?: string; phone?: string; reportWhatsapp?: string; active?: boolean; password?: string }) {
    await this.ensureRestaurant(restaurantId);
    const currentRestaurant = await this.restaurants.findById(restaurantId).lean();
    if (!currentRestaurant) throw new NotFoundException('Estabelecimento não encontrado.');
    let currentOwner: UserDocument | null = null;
    if (owner) {
      if (!Types.ObjectId.isValid(owner.userId)) throw new NotFoundException('Lojista não encontrado.');
      currentOwner = await this.users.findOne({ _id: owner.userId, restaurantId: new Types.ObjectId(restaurantId), role: Role.RESTAURANT_ADMIN });
      if (!currentOwner) throw new NotFoundException('Lojista responsável não encontrado neste estabelecimento.');
      if (owner.email) {
        const email = owner.email.trim().toLowerCase();
        if (await this.users.exists({ email, _id: { $ne: currentOwner._id } })) throw new ConflictException('Já existe um usuário cadastrado com este e-mail.');
      }
    }
    establishment.orderWhatsapp = normalizeBrazilianWhatsApp(establishment.orderWhatsapp);
    const restaurantChanges = updateDocument(establishment, ['tradeName', 'cnpj', 'email', 'phone', 'whatsapp', 'orderWhatsapp', 'instagram', 'address', 'description', 'logoUrl', 'bannerUrl', 'mapUrl', 'pickupInstructions']);
    try {
      const updatedRestaurant = await this.restaurants.findByIdAndUpdate(restaurantId, restaurantChanges, { new: true, runValidators: true });
      if (!updatedRestaurant) throw new NotFoundException('Estabelecimento não encontrado.');
      let updatedOwner: ReturnType<typeof storeUserSummary> | null = null;
      if (owner && currentOwner) updatedOwner = await this.applyStoreUserUpdate(currentOwner, restaurantId, owner);
      return { establishment: publicRestaurantDetail(updatedRestaurant), owner: updatedOwner };
    } catch (error) {
      // Restore the establishment if the linked owner update fails.
      await this.restaurants.replaceOne({ _id: restaurantId }, currentRestaurant);
      throw error;
    }
  }

  async list(): Promise<Array<Record<string, unknown>>> {
    const fields = 'name slug tradeName cnpj email phone whatsapp orderWhatsapp instagram address state city description logoUrl bannerUrl establishmentType restaurantCategories open blocked timezone';
    const restaurants = (await this.restaurants.find().select(fields).sort({ createdAt: -1 }).lean()).map(withDefaultType);
    const restaurantIds = restaurants.map((item) => item._id);
    const [owners, employeeCounts] = await Promise.all([
      this.users.find({ role: Role.RESTAURANT_ADMIN, restaurantId: { $in: restaurantIds }, deletedAt: null }).select('name email phone reportWhatsapp active restaurantId').sort({ createdAt: 1 }).lean(),
      this.users.aggregate<{ _id: Types.ObjectId; count: number }>([{ $match: { role: Role.EMPLOYEE, restaurantId: { $in: restaurantIds }, deletedAt: null } }, { $group: { _id: '$restaurantId', count: { $sum: 1 } } }]),
    ]);
    const ownerByRestaurant = new Map(owners.map((owner) => [owner.restaurantId?.toString(), ownerSummary(owner)]));
    const employeesByRestaurant = new Map(employeeCounts.map((item) => [item._id.toString(), item.count]));
    return restaurants.map((restaurant) => ({ ...restaurant, owner: ownerByRestaurant.get(restaurant._id.toString()) ?? null, employeeCount: employeesByRestaurant.get(restaurant._id.toString()) ?? 0 })) as Array<Record<string, unknown>>;
  }

  async addOwner(restaurantId: string, owner: { name: string; email: string; phone?: string; reportWhatsapp: string; password: string }) {
    if (!Types.ObjectId.isValid(restaurantId) || !(await this.restaurants.exists({ _id: restaurantId }))) throw new NotFoundException('Estabelecimento não encontrado.');
    if (await this.hasOwnerIncludingLegacyString(restaurantId)) throw new ConflictException('Este estabelecimento já possui um lojista responsável.');
    try { return await this.auth.create(owner.name, owner.email, owner.password, Role.RESTAURANT_ADMIN, restaurantId, owner.phone, owner.reportWhatsapp); }
    catch (error) { if (error instanceof ConflictException) throw new ConflictException('Já existe um usuário cadastrado com este e-mail.'); throw error; }
  }

  async addEmployee(restaurantId: string, employee: { name: string; email: string; phone?: string; password: string }) {
    await this.ensureRestaurant(restaurantId);
    try { return await this.auth.create(employee.name, employee.email, employee.password, Role.EMPLOYEE, restaurantId, employee.phone); }
    catch (error) { if (error instanceof ConflictException) throw new ConflictException('Já existe um usuário cadastrado com este e-mail.'); throw error; }
  }

  async updateStoreUser(restaurantId: string, userId: string, input: { name?: string; email?: string; phone?: string; reportWhatsapp?: string; active?: boolean; password?: string }) {
    await this.ensureRestaurant(restaurantId);
    if (!Types.ObjectId.isValid(userId)) throw new NotFoundException('Usuário não encontrado.');
    const user = await this.users.findOne({ _id: userId, restaurantId: new Types.ObjectId(restaurantId), role: { $in: [Role.RESTAURANT_ADMIN, Role.EMPLOYEE] }, deletedAt: null });
    if (!user) throw new NotFoundException('Usuário não encontrado neste estabelecimento.');
    return this.applyStoreUserUpdate(user, restaurantId, input);
  }

  private async applyStoreUserUpdate(user: UserDocument, restaurantId: string, input: { name?: string; email?: string; phone?: string; reportWhatsapp?: string; active?: boolean; password?: string }) {
    const changes: Record<string, unknown> = {};
    if (input.name !== undefined) changes.name = input.name.trim();
    if (input.phone !== undefined) changes.phone = input.phone.trim();
    if (input.reportWhatsapp !== undefined && user.role === Role.RESTAURANT_ADMIN) changes.reportWhatsapp = normalizeReportWhatsapp(input.reportWhatsapp);
    if (input.active !== undefined) changes.active = input.active;
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      if (await this.users.exists({ email, _id: { $ne: user._id } })) throw new ConflictException('Já existe um usuário cadastrado com este e-mail.');
      changes.email = email;
    }
    if (input.password) changes.passwordHash = await bcrypt.hash(input.password, 12);
    const updated = await this.users.findOneAndUpdate({ _id: user._id, restaurantId: new Types.ObjectId(restaurantId), role: user.role }, { $set: changes }, { new: true, runValidators: true }).select('name email phone reportWhatsapp role active restaurantId').lean();
    if (!updated) throw new NotFoundException('Usuário não encontrado.');
    return storeUserSummary(updated);
  }

  async usersForRestaurant(restaurantId: string) {
    if (!Types.ObjectId.isValid(restaurantId) || !(await this.restaurants.exists({ _id: restaurantId }))) throw new NotFoundException('Estabelecimento não encontrado.');
    return (await this.users.find({ restaurantId, role: { $in: [Role.RESTAURANT_ADMIN, Role.EMPLOYEE] }, deletedAt: null }).select('name email phone reportWhatsapp role active').sort({ createdAt: 1 }).lean()).map((user) => ({ id: user._id.toString(), name: user.name, email: user.email, phone: user.phone, reportWhatsapp: user.reportWhatsapp, role: user.role, active: user.active }));
  }

  async employeesForRestaurant(restaurantId: string) {
    await this.ensureRestaurant(restaurantId);
    return (await this.users.find({ restaurantId: new Types.ObjectId(restaurantId), role: Role.EMPLOYEE, deletedAt: null }).select('name email phone reportWhatsapp role active').sort({ createdAt: 1 }).lean()).map(storeUserSummary);
  }

  async updateEmployee(restaurantId: string, userId: string, input: { name?: string; email?: string; phone?: string; reportWhatsapp?: string; active?: boolean; password?: string }) {
    await this.ensureRestaurant(restaurantId);
    if (!Types.ObjectId.isValid(userId)) throw new NotFoundException('Funcionário não encontrado.');
    const user = await this.users.findOne({ _id: userId, restaurantId: new Types.ObjectId(restaurantId), role: Role.EMPLOYEE, deletedAt: null });
    if (!user) throw new NotFoundException('Funcionário não encontrado neste estabelecimento.');
    return this.applyStoreUserUpdate(user, restaurantId, input);
  }

  async deleteEmployee(restaurantId: string, userId: string) {
    await this.ensureRestaurant(restaurantId);
    if (!Types.ObjectId.isValid(userId)) throw new NotFoundException('Funcionário não encontrado.');
    const employee = await this.users.findOneAndUpdate(
      { _id: userId, restaurantId: new Types.ObjectId(restaurantId), role: Role.EMPLOYEE, deletedAt: null },
      { $set: { active: false, deletedAt: new Date() } },
      { new: true },
    ).select('name email phone reportWhatsapp role active').lean();
    if (!employee) throw new NotFoundException('Funcionário não encontrado neste estabelecimento.');
    return { message: 'Funcionário excluído; o histórico foi preservado.' };
  }

  ownerIntegrityDiagnostic() {
    return this.users.aggregate<{ restaurantId: Types.ObjectId; ownerCount: number }>([
      { $match: { role: Role.RESTAURANT_ADMIN } },
      { $group: { _id: '$restaurantId', ownerCount: { $sum: 1 } } },
      { $match: { ownerCount: { $gt: 1 } } },
      { $project: { _id: 0, restaurantId: { $toString: '$_id' }, ownerCount: 1 } },
      { $sort: { restaurantId: 1 } },
    ]);
  }

  publicCities() {
    return this.restaurants.aggregate<{ city: string; state: string; count: number; restaurants: number }>([
      { $match: { blocked: false, city: { $type: 'string', $ne: '' }, state: { $type: 'string', $ne: '' } } },
      { $group: { _id: { city: '$city', state: '$state' }, count: { $sum: 1 } } },
      { $project: { _id: 0, city: '$_id.city', state: '$_id.state', count: 1, restaurants: '$count' } },
      { $sort: { city: 1, state: 1 } },
    ]);
  }

  async publicList(query: { city?: string; state?: string; search?: string; type?: EstablishmentType; open?: boolean; page: number; limit: number }): Promise<Record<string, unknown>> {
    const filter: FilterQuery<RestaurantDocument> = { blocked: false };
    if (query.city) filter.city = new RegExp(`^${escapeRegExp(query.city.trim())}$`, 'i');
    if (query.state) filter.state = new RegExp(`^${escapeRegExp(query.state.trim())}$`, 'i');
    if (query.type === EstablishmentType.RESTAURANT) filter.$and = [{ $or: [{ establishmentType: EstablishmentType.RESTAURANT }, { establishmentType: { $exists: false } }] }];
    else if (query.type) filter.establishmentType = query.type;
    if (query.search?.trim()) {
      const search = new RegExp(escapeRegExp(query.search.trim()), 'i');
      const inferredType = typeForSearch(query.search);
      filter.$or = [{ name: search }, { tradeName: search }, { description: search }, { restaurantCategories: search }, ...(inferredType ? [{ establishmentType: inferredType }] : [])];
    }
    const select = 'name slug tradeName city state address mapUrl logoUrl bannerUrl description establishmentType restaurantCategories timezone open blocked';
    const restaurants = await this.restaurants.find(filter).select(select).sort({ name: 1 }).lean();
    const settings = await this.settings.find({ restaurantId: { $in: restaurants.map((restaurant) => restaurant._id) } }).select('restaurantId openingHours').lean();
    const hoursByRestaurant = new Map(settings.map((item) => [item.restaurantId.toString(), item.openingHours ?? []]));
    const withAvailability = restaurants.map((restaurant) => {
      const businessHours = hoursByRestaurant.get(restaurant._id.toString()) ?? [];
      return { ...withDefaultType(restaurant), ...restaurantAvailability(businessHours, restaurant.timezone, restaurant.open, restaurant.blocked) };
    });
    const filtered = query.open === undefined ? withAvailability : withAvailability.filter((restaurant) => restaurant.isOpenNow === query.open);
    const total = filtered.length;
    const start = (query.page - 1) * query.limit;
    return { items: filtered.slice(start, start + query.limit), pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) } };
  }

  async bySlug(slug: string): Promise<Record<string, unknown>> { const restaurant = await this.restaurants.findOne({ slug, blocked: false }).select('name slug tradeName address city state mapUrl pickupInstructions logoUrl bannerUrl description phone orderWhatsapp instagram establishmentType restaurantCategories timezone open blocked').lean(); if (!restaurant) throw new NotFoundException('Establishment not found'); const [settings, deliveryZones, paymentMethods] = await Promise.all([this.settings.findOne({ restaurantId: restaurant._id }).select('openingHours minimumOrder minimumOrderCents pickupEnabled deliveryEnabled').lean(), this.deliveryZones.find({ restaurantId: restaurant._id, active: true }).select('name coverageType fee feeCents active').sort({ name: 1 }).lean(), this.payments.find({ restaurantId: restaurant._id, active: true }).select('name method active').sort({ method: 1 }).lean()]); const businessHours = settings?.openingHours ?? []; const delivery = deliveryAvailability(settings?.deliveryEnabled ?? false, deliveryZones.length); return { ...withDefaultType(restaurant), timezone: restaurant.timezone || DEFAULT_TIMEZONE, deliveryZones, paymentMethods, pickupEnabled: settings?.pickupEnabled ?? true, ...delivery, minimumOrderCents: settings?.minimumOrderCents ?? Math.round((settings?.minimumOrder ?? 0) * 100), customerServiceFeeCents: MENU_FLOW_ORDER_SERVICE_FEE_CENTS, ...restaurantAvailability(businessHours, restaurant.timezone, restaurant.open, restaurant.blocked) }; }
  async ensureAcceptingOrders(restaurantId: string) { if (!Types.ObjectId.isValid(restaurantId)) throw new NotFoundException('Restaurant not found'); const restaurant = await this.restaurants.findOne({ _id: restaurantId, blocked: false }).lean(); if (!restaurant) throw new NotFoundException('Restaurant not found'); const settings = await this.settings.findOne({ restaurantId }).lean(); return { restaurant, settings }; }
  async update(id: string, input: Partial<Restaurant>, actorRole: Role) { input.orderWhatsapp = normalizeBrazilianWhatsApp(input.orderWhatsapp); if (actorRole !== Role.SUPER_ADMIN && (input.blocked !== undefined || input.establishmentType !== undefined || input.slug !== undefined)) throw new ForbiddenException('Somente administradores da plataforma podem alterar este campo.'); const restaurant = await this.restaurants.findByIdAndUpdate(id, updateDocument(input, ['tradeName', 'cnpj', 'email', 'phone', 'whatsapp', 'orderWhatsapp', 'instagram', 'address', 'description', 'logoUrl', 'bannerUrl', 'mapUrl', 'pickupInstructions']), { new: true, runValidators: true }); if (!restaurant) throw new NotFoundException('Establishment not found'); return restaurant; }
  async updateSettings(id: string, input: Partial<RestaurantSettings>) {
    await this.ensureRestaurant(id);
    const restaurantId = new Types.ObjectId(id);
    const normalized = { ...input, ...(input.minimumOrder !== undefined ? { minimumOrderCents: Math.round(input.minimumOrder * 100) } : {}) };
    const existing = await this.settings.findOne({ restaurantId });
    if (existing) return this.settings.findByIdAndUpdate(existing._id, { $set: normalized }, { new: true, runValidators: true });
    const legacy = await this.settings.collection.findOne({ restaurantId: id });
    if (legacy) {
      await this.settings.collection.updateOne({ _id: legacy._id, restaurantId: id }, { $set: { restaurantId, ...normalized } });
      return this.settings.findById(legacy._id).lean();
    }
    return this.settings.create({ restaurantId, ...normalized });
  }
  async businessHours(id: string): Promise<Record<string, unknown>> {
    await this.ensureRestaurant(id);
    const restaurantId = new Types.ObjectId(id);
    const [restaurant, settings] = await Promise.all([
      this.restaurants.findById(restaurantId).select('name timezone').lean(),
      this.settings.findOne({ restaurantId }).lean(),
    ]);
    const days = Array.isArray(settings?.openingHours) ? settings.openingHours : [];
    return { restaurantId: id, restaurantName: restaurant!.name, timezone: restaurant!.timezone || DEFAULT_TIMEZONE, configured: days.length > 0, days };
  }
  async updateBusinessHours(id: string, days: BusinessDay[], actorId: string, admin: boolean): Promise<Record<string, unknown>> {
    await this.ensureRestaurant(id);
    const restaurantId = new Types.ObjectId(id);
    const normalized = validateBusinessHours(days);
    try {
      // Do not combine the equality filter and $setOnInsert for restaurantId. Besides
      // triggering conflicting-update errors on some deployed MongoDB/Mongoose
      // combinations, that upsert silently creates a second settings document when
      // an old installation stored restaurantId as a BSON string.
      let settings = await this.settings.findOne({ restaurantId });
      if (!settings) {
        const legacy = await this.settings.collection.findOne({ restaurantId: id });
        if (legacy) {
          await this.settings.collection.updateOne(
            { _id: legacy._id, restaurantId: id },
            { $set: { restaurantId, openingHours: normalized } },
          );
          settings = await this.settings.findById(legacy._id);
        } else {
          try { settings = await this.settings.create({ restaurantId, openingHours: normalized }); }
          catch (error) {
            // A concurrent first save may win the unique index race.
            if ((error as { code?: number }).code !== 11000) throw error;
            settings = await this.settings.findOne({ restaurantId });
            if (!settings) throw error;
            settings.openingHours = normalized;
            await settings.save();
          }
        }
      } else {
        settings.openingHours = normalized;
        await settings.save();
      }
      if (!settings) throw new Error('RestaurantSettings was not readable after persistence');
      if (admin) await this.audits.create({ actorId: new Types.ObjectId(actorId), action: 'BUSINESS_HOURS_UPDATED', targetType: 'Restaurant', targetId: restaurantId, metadata: { periods: normalized.reduce((sum, day) => sum + day.periods.length, 0) } });
      const restaurant = await this.restaurants.findById(restaurantId).select('timezone').lean();
      return { restaurantId: id, timezone: restaurant?.timezone || DEFAULT_TIMEZONE, configured: true, days: settings.openingHours };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.error(`Business-hours persistence failed (restaurantId=${id}, days=${normalized.length}): ${detail}`, error instanceof Error ? error.stack : undefined);
      throw new InternalServerErrorException('Não foi possível salvar os horários de funcionamento. Tente novamente.');
    }
  }

  async operationalSettings(restaurantId: string) {
    await this.ensureRestaurant(restaurantId);
    const rid = new Types.ObjectId(restaurantId);
    const [deliveryZones, paymentMethods] = await Promise.all([
      this.deliveryZones.find({ restaurantId: rid }).sort({ name: 1 }).lean(),
      this.payments.find({ restaurantId: rid }).sort({ method: 1 }).lean(),
    ]);
    const settings = await this.settings.findOne({ restaurantId: rid }).select('pickupEnabled deliveryEnabled').lean();
    return { deliveryZones, paymentMethods, pickupEnabled: settings?.pickupEnabled ?? true, ...deliveryAvailability(settings?.deliveryEnabled ?? false, deliveryZones.filter((zone) => zone.active).length) };
  }

  async saveDeliveryZone(restaurantId: string, input: { id?: string; coverageType: 'ALL' | 'SPECIFIC'; name?: string; fee: number; active?: boolean }) {
    await this.ensureRestaurant(restaurantId);
    const rid = new Types.ObjectId(restaurantId);
    if (input.id && !Types.ObjectId.isValid(input.id)) throw new NotFoundException('Região de entrega não encontrada.');
    const name = input.coverageType === 'ALL' ? 'Todos os bairros' : input.name?.trim();
    if (!name) throw new BadRequestException('Informe o bairro atendido.');
    const duplicateFilter = input.coverageType === 'ALL' ? { coverageType: 'ALL' } : { coverageType: 'SPECIFIC', name: new RegExp(`^${escapeRegExp(name)}$`, 'i') };
    const filter = input.id ? { _id: new Types.ObjectId(input.id), restaurantId: rid } : { restaurantId: rid, ...duplicateFilter };
    const duplicate = await this.deliveryZones.exists({ restaurantId: rid, ...duplicateFilter, ...(input.id ? { _id: { $ne: new Types.ObjectId(input.id) } } : {}) });
    if (duplicate) throw new ConflictException('Já existe uma região de entrega com esse nome.');
    if (input.active ?? true) await this.deliveryZones.updateMany({ restaurantId: rid, coverageType: { $ne: input.coverageType }, active: true }, { $set: { active: false } });
    const zone = await this.deliveryZones.findOneAndUpdate(filter, { $set: { name, coverageType: input.coverageType, fee: input.fee, feeCents: Math.round(input.fee * 100), active: input.active ?? true } }, { new: true, upsert: !input.id, runValidators: true }).lean();
    if (!zone) throw new NotFoundException('Região de entrega não encontrada.');
    return zone;
  }

  async savePaymentMethod(restaurantId: string, input: { method: string; name: string; active: boolean }) {
    await this.ensureRestaurant(restaurantId);
    return this.payments.findOneAndUpdate(
      { restaurantId: new Types.ObjectId(restaurantId), method: input.method },
      { $set: { name: input.name.trim(), active: input.active } },
      { new: true, upsert: true, runValidators: true },
    ).lean();
  }

  private async validateLocation(state?: string, city?: string) {
    if (!state || !city) throw new BadRequestException('Estado e cidade válidos são obrigatórios.');
    const cities = await this.locations.cities(state);
    if (!cities.some((candidate) => candidate.name === city.trim())) throw new BadRequestException('A cidade não pertence ao estado selecionado.');
  }

  private async ensureRestaurant(restaurantId: string) {
    if (!Types.ObjectId.isValid(restaurantId) || !(await this.restaurants.exists({ _id: new Types.ObjectId(restaurantId) }))) throw new NotFoundException('Estabelecimento não encontrado.');
  }

  private async hasOwnerIncludingLegacyString(restaurantId: string) {
    return Boolean(await this.users.collection.findOne({
      role: Role.RESTAURANT_ADMIN,
      $expr: { $eq: [{ $convert: { input: '$restaurantId', to: 'objectId', onError: null, onNull: null } }, new Types.ObjectId(restaurantId)] },
    }, { projection: { _id: 1 } }));
  }
}

function publicRestaurant(restaurant: RestaurantDocument) { return { id: restaurant.id, name: restaurant.name, slug: restaurant.slug, city: restaurant.city, state: restaurant.state, establishmentType: restaurant.establishmentType }; }
function publicRestaurantDetail(restaurant: RestaurantDocument) { const value = restaurant.toObject(); delete (value as { __v?: number }).__v; return withDefaultType(value); }
function ownerSummary(owner: { _id: Types.ObjectId; name: string; email: string; phone?: string; reportWhatsapp?: string; active: boolean }) { return { id: owner._id.toString(), name: owner.name, email: owner.email, phone: owner.phone, reportWhatsapp: owner.reportWhatsapp, active: owner.active }; }
function storeUserSummary(user: { _id: Types.ObjectId; name: string; email: string; phone?: string; reportWhatsapp?: string; role: Role; active: boolean }) { return { id: user._id.toString(), name: user.name, email: user.email, phone: user.phone, reportWhatsapp: user.reportWhatsapp, role: user.role, active: user.active }; }

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function withDefaultType<T extends { establishmentType?: EstablishmentType }>(item: T): T & { establishmentType: EstablishmentType } { return { ...item, establishmentType: item.establishmentType ?? EstablishmentType.RESTAURANT }; }
function typeForSearch(value: string) { const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); if (/farmacia/.test(normalized)) return EstablishmentType.PHARMACY; if (/roupa|vestuario/.test(normalized)) return EstablishmentType.CLOTHING; if (/restaurante/.test(normalized)) return EstablishmentType.RESTAURANT; return undefined; }

function restaurantAvailability(businessHours: BusinessDay[], timezone?: string, acceptingOrders = true, blocked = false) {
  const availability = canAcceptOrdersNow({ blocked, acceptingOrders, openingHours: businessHours, timezone });
  const current = availability.openingStatus;
  return {
    businessHours,
    businessHoursConfigured: current.status !== 'UNCONFIGURED',
    isOpenNow: availability.canAcceptOrdersNow,
    canAcceptOrdersNow: availability.canAcceptOrdersNow,
    acceptingOrders,
    openingStatus: current,
  };
}

function updateDocument(input: Partial<Restaurant>, clearable: Array<keyof Restaurant>) {
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  for (const [key, value] of Object.entries(input)) {
    if (clearable.includes(key as keyof Restaurant) && value === '') unset[key] = 1;
    else if (value !== undefined) set[key] = value;
  }
  return { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) };
}

export function deliveryAvailability(deliveryEnabled: boolean, activeZoneCount: number) {
  const deliveryAvailable = deliveryEnabled && activeZoneCount > 0;
  return {
    deliveryEnabled,
    deliveryAvailable,
    ...(deliveryEnabled && !deliveryAvailable ? { deliveryUnavailableReason: 'Nenhuma região de entrega ativa.' } : {}),
  };
}
