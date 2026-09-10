import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { Model, Types } from 'mongoose';
import { Role } from '../common/roles';
import { Restaurant, User, UserDocument } from '../common/schemas';
import { normalizeReportWhatsapp } from '../users/report-whatsapp';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Restaurant.name) private readonly restaurants: Model<Restaurant>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}
  async onModuleInit() {
    if (this.config.get<string>('NODE_ENV') === 'production' || this.config.get<string>('ADMIN_SEED_ENABLED') !== 'true') return;
    const name = this.config.get<string>('ADMIN_NAME');
    const email = this.config.get<string>('ADMIN_EMAIL')?.trim().toLowerCase();
    const password = this.config.get<string>('ADMIN_PASSWORD');
    if (!name || !email || !password) { this.logger.warn('ADMIN_SEED_ENABLED requires ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD.'); return; }
    if (await this.users.exists({ role: Role.SUPER_ADMIN })) return;
    if (await this.users.exists({ email })) { this.logger.warn('Initial admin was not created because ADMIN_EMAIL is already in use.'); return; }
    await this.create(name, email, password, Role.SUPER_ADMIN);
    this.logger.log('Initial SUPER_ADMIN created from development environment configuration.');
  }
  async bootstrap(name: string, email: string, password: string) { if (this.config.get<string>('NODE_ENV') === 'production') throw new ForbiddenException('Bootstrap is disabled in production. Use the administrative creation script.'); if (await this.users.exists({})) throw new ConflictException('Bootstrap is only available before the first user'); return this.create(name, email, password, Role.SUPER_ADMIN); }
  async create(name: string, email: string, password: string, role: Role, restaurantId?: string, phone?: string, reportWhatsapp?: string) {
    email = email.trim().toLowerCase();
    const requiresRestaurant = role === Role.RESTAURANT_ADMIN || role === Role.EMPLOYEE;
    const normalizedReportWhatsapp = role === Role.RESTAURANT_ADMIN ? normalizeReportWhatsapp(reportWhatsapp) : undefined;
    if ((requiresRestaurant && !restaurantId) || (!requiresRestaurant && restaurantId)) throw new BadRequestException('Restaurant membership does not match the selected role');
    if (restaurantId && (!Types.ObjectId.isValid(restaurantId) || !(await this.restaurants.exists({ _id: new Types.ObjectId(restaurantId) })))) throw new BadRequestException('Restaurant not found');
    const normalizedRestaurantId = restaurantId ? new Types.ObjectId(restaurantId) : undefined;
    if (role === Role.RESTAURANT_ADMIN && await this.users.collection.findOne({
      role: Role.RESTAURANT_ADMIN,
      $expr: { $eq: [{ $convert: { input: '$restaurantId', to: 'objectId', onError: null, onNull: null } }, normalizedRestaurantId] },
    }, { projection: { _id: 1 } })) {
      throw new ConflictException('Este estabelecimento já possui um lojista responsável.');
    }
    if (await this.users.exists({ email })) throw new ConflictException('Email already exists');
    const user = await this.users.create({ name, email, phone, reportWhatsapp: normalizedReportWhatsapp, passwordHash: await bcrypt.hash(password, 12), role, restaurantId: normalizedRestaurantId, active: true });
    return { id: user.id, name: user.name, email: user.email, phone: user.phone, reportWhatsapp: user.reportWhatsapp, role: user.role, restaurantId: user.restaurantId?.toString() };
  }
  registerCustomer(name: string, email: string, password: string, phone: string) { return this.create(name, email, password, Role.CUSTOMER, undefined, phone); }
  async profile(id: string) {
    const user = await this.users.findOne({ _id: id, $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }] }).lean();
    if (!user || !user.active) throw new UnauthorizedException('Invalid credentials');
    await this.validateMembership(user.role, user.restaurantId?.toString());
    return { id: user._id.toString(), name: user.name, email: user.email, phone: user.phone, reportWhatsapp: user.reportWhatsapp, role: user.role, restaurantId: user.restaurantId?.toString() };
  }
  async updateProfile(id: string, input: { name?: string; phone?: string; reportWhatsapp?: string }) {
    const changes: Record<string, string> = {};
    if (input.name !== undefined) changes.name = input.name.trim();
    if (input.phone !== undefined) changes.phone = input.phone.trim();
    if (input.reportWhatsapp !== undefined) { const normalized = normalizeReportWhatsapp(input.reportWhatsapp); if (normalized) changes.reportWhatsapp = normalized; }
    const user = await this.users.findByIdAndUpdate(id, { $set: changes }, { new: true, runValidators: true });
    if (!user || !user.active) throw new UnauthorizedException('Invalid credentials');
    return this.profile(user.id);
  }
  async login(email: string, password: string) { const user = await this.users.findOne({ email: email.trim().toLowerCase(), $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }] }).select('+passwordHash'); if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) throw new UnauthorizedException('Invalid credentials'); await this.validateMembership(user.role, user.restaurantId?.toString()); return { accessToken: await this.jwt.signAsync({ sub: user.id, role: user.role, ...(user.restaurantId ? { restaurantId: user.restaurantId.toString() } : {}) }), user: { id: user.id, name: user.name, email: user.email, phone: user.phone, reportWhatsapp: user.reportWhatsapp, role: user.role, restaurantId: user.restaurantId?.toString() } }; }
  private async validateMembership(role: Role, restaurantId?: string) { const membership = role === Role.RESTAURANT_ADMIN || role === Role.EMPLOYEE; if (!membership) { if (restaurantId) throw new UnauthorizedException('Invalid credentials'); return; } if (!restaurantId || !Types.ObjectId.isValid(restaurantId) || !(await this.restaurants.exists({ _id: new Types.ObjectId(restaurantId), blocked: false }))) throw new UnauthorizedException('Invalid credentials'); }
}
