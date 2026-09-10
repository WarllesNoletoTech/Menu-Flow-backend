import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditLog, HomeBanner, HomeBannerDocument } from '../common/schemas';
import { CreateHomeBannerDto, UpdateHomeBannerDto } from './home-banners.controller';

@Injectable()
export class HomeBannersService {
  constructor(@InjectModel(HomeBanner.name) private readonly banners: Model<HomeBannerDocument>, @InjectModel(AuditLog.name) private readonly audits: Model<AuditLog>) {}
  async adminList(): Promise<Array<Record<string, unknown>>> { return (await this.banners.find().sort({ sortOrder: 1, createdAt: 1 }).lean()).map(item => ({ ...item, id: item._id.toString() })); }
  async publicList() { return (await this.banners.find({ active: true }).select('title description desktopImageUrl mobileImageUrl targetUrl').sort({ sortOrder: 1, createdAt: 1 }).lean()).map(item => ({ id: item._id.toString(), title: item.title, description: item.description, desktopImageUrl: item.desktopImageUrl, mobileImageUrl: item.mobileImageUrl, targetUrl: item.targetUrl })); }
  async create(input: CreateHomeBannerDto, actorId: string) { const actor = new Types.ObjectId(actorId); const item = await this.banners.create({ ...this.clean(input), active: input.active ?? true, sortOrder: input.sortOrder ?? 0, createdBy: actor, updatedBy: actor }); await this.audit(actor, 'HOME_BANNER_CREATED', item._id); return item; }
  async update(id: string, input: UpdateHomeBannerDto, actorId: string) { this.validId(id); const previous = await this.banners.findById(id).lean(); if (!previous) throw new NotFoundException('Banner não encontrado.'); const item = await this.banners.findByIdAndUpdate(id, { $set: { ...this.clean(input), updatedBy: new Types.ObjectId(actorId) } }, { new: true, runValidators: true }); await this.audit(new Types.ObjectId(actorId), previous.active !== input.active && input.active !== undefined ? 'HOME_BANNER_STATUS_CHANGED' : 'HOME_BANNER_UPDATED', new Types.ObjectId(id)); return item; }
  async remove(id: string, actorId: string) { this.validId(id); const item = await this.banners.findByIdAndDelete(id); if (!item) throw new NotFoundException('Banner não encontrado.'); await this.audit(new Types.ObjectId(actorId), 'HOME_BANNER_DELETED', item._id); return { message: 'Banner excluído com sucesso.' }; }
  private clean<T extends CreateHomeBannerDto | UpdateHomeBannerDto>(input: T) { return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]).filter(([, value]) => value !== '')); }
  private validId(id: string) { if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Banner não encontrado.'); }
  private audit(actorId: Types.ObjectId, action: string, targetId: Types.ObjectId) { return this.audits.create({ actorId, action, targetType: 'HomeBanner', targetId }); }
}
