import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { Model, Types } from 'mongoose';
import { Role } from '../common/roles';
import { Restaurant, User, UserDocument } from '../common/schemas';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Restaurant.name) private readonly restaurants: Model<Restaurant>,
    private readonly jwt: JwtService,
  ) {}
  async bootstrap(name: string, email: string, password: string) { if (await this.users.exists({})) throw new ConflictException('Bootstrap is only available before the first user'); return this.create(name, email, password, Role.SUPER_ADMIN); }
  async create(name: string, email: string, password: string, role: Role, restaurantId?: string) {
    if ((role === Role.SUPER_ADMIN && restaurantId) || (role !== Role.SUPER_ADMIN && !restaurantId)) throw new BadRequestException('Restaurant membership does not match the selected role');
    if (restaurantId && (!Types.ObjectId.isValid(restaurantId) || !(await this.restaurants.exists({ _id: restaurantId })))) throw new BadRequestException('Restaurant not found');
    if (await this.users.exists({ email })) throw new ConflictException('Email already exists');
    const user = await this.users.create({ name, email, passwordHash: await bcrypt.hash(password, 12), role, restaurantId });
    return { id: user.id, email: user.email, role: user.role };
  }
  async login(email: string, password: string) { const user = await this.users.findOne({ email }).select('+passwordHash'); if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) throw new UnauthorizedException('Invalid credentials'); return { accessToken: await this.jwt.signAsync({ sub: user.id, role: user.role, restaurantId: user.restaurantId?.toString() }), user: { id: user.id, name: user.name, role: user.role, restaurantId: user.restaurantId } }; }
}
