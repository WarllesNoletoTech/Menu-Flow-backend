import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { IsBoolean, IsEmail, IsEnum, IsMongoId, IsOptional, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../auth/auth.service';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { AuditLog, EstablishmentType, Restaurant, User } from '../common/schemas';

class CreateUserDto { @IsString() name!: string; @IsEmail() email!: string; @IsString() @MinLength(8) password!: string; @IsEnum(Role) role!: Role; @IsOptional() @IsMongoId() restaurantId?: string; }
class UpdateUserDto { @IsOptional() @IsString() @MinLength(1) name?: string; @IsOptional() @IsEmail() email?: string; @IsOptional() @IsString() phone?: string; }
class StatusDto { @IsBoolean() active!: boolean; }
class PasswordDto { @IsString() @MinLength(8) password!: string; }

@Controller('users') @UseGuards(JwtGuard, RolesGuard) @Roles(Role.SUPER_ADMIN)
export class UsersController {
  constructor(private readonly auth: AuthService, @InjectModel(User.name) private readonly users: Model<User>, @InjectModel(Restaurant.name) private readonly restaurants: Model<Restaurant>, @InjectModel(AuditLog.name) private readonly audits: Model<AuditLog>) {}
  @Get() async list(@Query('page') requestedPage?: string, @Query('limit') requestedLimit?: string, @Query('search') search?: string, @Query('role') role?: Role, @Query('status') status = 'all') {
    const filter: Record<string, unknown> = {};
    if (search?.trim()) filter.$or = [{ name: { $regex: escapeRegExp(search.trim()), $options: 'i' } }, { email: { $regex: escapeRegExp(search.trim()), $options: 'i' } }];
    if (role && Object.values(Role).includes(role)) filter.role = role;
    if (status === 'active') Object.assign(filter, { active: true, deletedAt: { $exists: false } });
    else if (status === 'blocked') Object.assign(filter, { active: false, deletedAt: { $exists: false } });
    else if (status === 'deleted') filter.deletedAt = { $exists: true };
    else filter.deletedAt = { $exists: false };
    const page = Math.max(1, Number(requestedPage) || 1), limit = Math.min(100, Math.max(1, Number(requestedLimit) || 20));
    const [items, total] = await Promise.all([this.users.find(filter).select('name email phone role active deletedAt restaurantId createdAt updatedAt').populate('restaurantId', 'name tradeName').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), this.users.countDocuments(filter)]);
    return { items: items.map(userView), pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }
  @Get('dashboard') async dashboard() { const [total, active, blocked, byType] = await Promise.all([this.restaurants.countDocuments(), this.restaurants.countDocuments({ blocked: false }), this.restaurants.countDocuments({ blocked: true }), this.restaurants.aggregate<{ _id: EstablishmentType; count: number }>([{ $group: { _id: '$establishmentType', count: { $sum: 1 } } }])]); return { total, active, blocked, types: Object.fromEntries(Object.values(EstablishmentType).map((type) => [type, byType.find((item) => item._id === type)?.count ?? 0])) }; }
  @Get(':userId') async detail(@Param('userId') id: string) { return userView(await this.find(id)); }
  @Patch(':userId') async update(@Param('userId') id: string, @Body() body: UpdateUserDto) { const user = await this.find(id); const changes: Record<string, unknown> = {}; if (body.name !== undefined) changes.name = body.name.trim(); if (body.phone !== undefined) changes.phone = body.phone.trim(); if (body.email !== undefined) { const email = body.email.trim().toLowerCase(); if (await this.users.exists({ email, _id: { $ne: user._id } })) throw new ConflictException('Já existe um usuário cadastrado com este e-mail.'); changes.email = email; } const updated = await this.users.findByIdAndUpdate(id, { $set: changes }, { new: true, runValidators: true }).select('name email phone role active deletedAt restaurantId createdAt updatedAt').populate('restaurantId', 'name tradeName').lean(); return userView(updated!); }
  @Patch(':userId/status') async status(@Param('userId') id: string, @Body() body: StatusDto, @Req() req: ActorRequest) { const user = await this.find(id); if (user.deletedAt) throw new BadRequestException('Restaure o usuário antes de alterar seu status.'); if (!body.active) await this.protectAdmin(user, req.user.sub, 'Você não pode bloquear sua própria conta.'); await this.users.updateOne({ _id: user._id }, { $set: { active: body.active } }); await this.audit(req.user.sub, body.active ? 'USER_UNBLOCKED' : 'USER_BLOCKED', user._id); return { ...userView(user), active: body.active }; }
  @Patch(':userId/password') async password(@Param('userId') id: string, @Body() body: PasswordDto, @Req() req: ActorRequest) { const user = await this.find(id); await this.users.updateOne({ _id: user._id }, { $set: { passwordHash: await bcrypt.hash(body.password, 12) } }); await this.audit(req.user.sub, 'USER_PASSWORD_RESET', user._id); return { message: 'Senha redefinida com sucesso.' }; }
  @Patch(':userId/delete') async remove(@Param('userId') id: string, @Req() req: ActorRequest) { const user = await this.find(id); if (user.role === Role.RESTAURANT_ADMIN) throw new BadRequestException('O lojista responsável não pode ser excluído. Edite ou bloqueie o mesmo registro.'); await this.protectAdmin(user, req.user.sub, 'Você não pode excluir sua própria conta.'); await this.users.updateOne({ _id: user._id }, { $set: { active: false, deletedAt: new Date() } }); await this.audit(req.user.sub, 'USER_DELETED', user._id); return { message: 'Usuário excluído; o histórico foi preservado.' }; }
  @Patch(':userId/restore') async restore(@Param('userId') id: string, @Req() req: ActorRequest) { const user = await this.find(id); if (!user.deletedAt) throw new BadRequestException('Este usuário não está excluído.'); await this.users.updateOne({ _id: user._id }, { $set: { active: false }, $unset: { deletedAt: 1 } }); await this.audit(req.user.sub, 'USER_RESTORED', user._id); return { message: 'Usuário restaurado e mantido bloqueado.' }; }
  @Post() create(@Body() body: CreateUserDto) {
    if (body.role === Role.SUPER_ADMIN) throw new BadRequestException('Administradores exigem uma operação de segurança específica.');
    if (body.role === Role.RESTAURANT_ADMIN || body.role === Role.EMPLOYEE) throw new BadRequestException('Use a rota do estabelecimento para cadastrar lojistas ou funcionários.');
    return this.auth.create(body.name, body.email, body.password, body.role, body.restaurantId);
  }
  private async find(id: string) { if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Usuário não encontrado.'); const user = await this.users.findById(id).select('name email phone role active deletedAt restaurantId createdAt updatedAt').populate('restaurantId', 'name tradeName').lean(); if (!user) throw new NotFoundException('Usuário não encontrado.'); return user; }
  private async protectAdmin(user: any, actorId: string, selfMessage: string) { if (user._id.toString() === actorId) throw new BadRequestException(selfMessage); if (user.role === Role.SUPER_ADMIN && user.active && !user.deletedAt && await this.users.countDocuments({ role: Role.SUPER_ADMIN, active: true, deletedAt: { $exists: false } }) <= 1) throw new BadRequestException('Não é possível remover o último administrador ativo.'); }
  private audit(actorId: string, action: string, targetId: Types.ObjectId) { return this.audits.create({ actorId, action, targetType: 'User', targetId }); }
}
type ActorRequest = { user: { sub: string } };
function userView(user: any) { const restaurant = user.restaurantId && typeof user.restaurantId === 'object' && ('name' in user.restaurantId); return { id: user._id.toString(), name: user.name, email: user.email, phone: user.phone, role: user.role, active: user.active, deletedAt: user.deletedAt ?? null, restaurantId: restaurant ? user.restaurantId._id.toString() : user.restaurantId?.toString(), establishment: restaurant ? user.restaurantId.tradeName || user.restaurantId.name : null, createdAt: user.createdAt, updatedAt: user.updatedAt }; }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

@Controller('employees') @UseGuards(JwtGuard, RolesGuard) @Roles(Role.RESTAURANT_ADMIN)
export class EmployeesController { constructor(private readonly auth: AuthService) {} @Post() create(@Body() body: Omit<CreateUserDto, 'role' | 'restaurantId'>, @Req() request: { user: { restaurantId: string } }) { return this.auth.create(body.name, body.email, body.password, Role.EMPLOYEE, request.user.restaurantId); } }
