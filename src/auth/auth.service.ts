import { BadRequestException, ConflictException, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { Model, Types } from 'mongoose';
import { Role } from '../common/roles';
import { Restaurant, User, UserDocument } from '../common/schemas';

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
  async bootstrap(name: string, email: string, password: string) { if (await this.users.exists({})) throw new ConflictException('Bootstrap is only available before the first user'); return this.create(name, email, password, Role.SUPER_ADMIN); }
  async create(name: string, email: string, password: string, role: Role, restaurantId?: string) {
    email = email.trim().toLowerCase();
    if ((role === Role.SUPER_ADMIN && restaurantId) || (role !== Role.SUPER_ADMIN && !restaurantId)) throw new BadRequestException('Restaurant membership does not match the selected role');
    if (restaurantId && (!Types.ObjectId.isValid(restaurantId) || !(await this.restaurants.exists({ _id: restaurantId })))) throw new BadRequestException('Restaurant not found');
    if (await this.users.exists({ email })) throw new ConflictException('Email already exists');
    const user = await this.users.create({ name, email, passwordHash: await bcrypt.hash(password, 12), role, restaurantId });
    return { id: user.id, email: user.email, role: user.role };
  }
  async profile(id: string) {
    const user = await this.users.findById(id).lean();
    if (!user || !user.active) throw new UnauthorizedException('Invalid credentials');
    return { id: user._id.toString(), name: user.name, role: user.role, restaurantId: user.restaurantId?.toString() };
  }
  async login(email: string, password: string) { const user = await this.users.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash'); if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) throw new UnauthorizedException('Invalid credentials'); return { accessToken: await this.jwt.signAsync({ sub: user.id, role: user.role, restaurantId: user.restaurantId?.toString() }), user: { id: user.id, name: user.name, role: user.role, restaurantId: user.restaurantId } }; }
}
