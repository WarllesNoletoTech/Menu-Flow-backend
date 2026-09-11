import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditLog, HomeBanner, HomeBannerDocument } from '../common/schemas';
import { BannerImage, BannerStorageService, BannerUploadFile } from './banner-storage.service';
import { BannerFiles, CreateHomeBannerDto, UpdateHomeBannerDto } from './home-banners.controller';

export function isAllowedBannerImage(file: Pick<BannerUploadFile, 'buffer' | 'mimetype' | 'size'>) {
  if (file.size > 5 * 1024 * 1024) return false;
  const bytes = file.buffer;
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return (file.mimetype === 'image/jpeg' && jpeg) || (file.mimetype === 'image/png' && png) || (file.mimetype === 'image/webp' && webp);
}

@Injectable()
export class HomeBannersService {
  constructor(
    @InjectModel(HomeBanner.name) private readonly banners: Model<HomeBannerDocument>,
    @InjectModel(AuditLog.name) private readonly audits: Model<AuditLog>,
    private readonly storage: BannerStorageService,
  ) {}

  async adminList(): Promise<Array<Record<string, unknown>>> { return (await this.banners.find().sort({ sortOrder: 1, createdAt: 1 }).lean()).map(item => ({ ...item, id: item._id.toString() })); }
  async publicList() { return (await this.banners.find({ active: true }).select('title description desktopImageUrl mobileImageUrl targetUrl').sort({ sortOrder: 1, createdAt: 1 }).lean()).map(item => ({ id: item._id.toString(), title: item.title, description: item.description, desktopImageUrl: item.desktopImageUrl, mobileImageUrl: item.mobileImageUrl, targetUrl: item.targetUrl ?? null })); }

  async create(input: CreateHomeBannerDto, files: BannerFiles, actorId: string) {
    const desktop = files.desktopImage?.[0];
    const mobile = files.mobileImage?.[0];
    if (!desktop) throw new BadRequestException('Anexe a imagem para computador.');
    if (!mobile) throw new BadRequestException('Anexe a imagem para celular.');
    this.validateImage(desktop);
    this.validateImage(mobile);
    const uploaded: BannerImage[] = [];
    let committed = false;
    try {
      uploaded.push(await this.storage.upload(desktop, 'desktop'));
      uploaded.push(await this.storage.upload(mobile, 'mobile'));
      const actor = new Types.ObjectId(actorId);
      const item = await this.banners.create({
        ...this.clean(input),
        desktopImageUrl: uploaded[0].url,
        desktopImagePublicId: uploaded[0].publicId,
        mobileImageUrl: uploaded[1].url,
        mobileImagePublicId: uploaded[1].publicId,
        active: input.active ?? true,
        sortOrder: input.sortOrder ?? 0,
        createdBy: actor,
        updatedBy: actor,
      });
      committed = true;
      await this.audit(actor, 'HOME_BANNER_CREATED', item._id).catch(() => undefined);
      return item;
    } catch (error) {
      if (!committed) await Promise.allSettled(uploaded.map(image => this.storage.remove(image.publicId)));
      throw error;
    }
  }

  async update(id: string, input: UpdateHomeBannerDto, files: BannerFiles, actorId: string) {
    this.validId(id);
    const previous = await this.banners.findById(id).lean();
    if (!previous) throw new NotFoundException('Banner não encontrado.');
    const desktopFile = files.desktopImage?.[0];
    const mobileFile = files.mobileImage?.[0];
    if (desktopFile) this.validateImage(desktopFile);
    if (mobileFile) this.validateImage(mobileFile);
    const uploaded: Partial<Record<'desktop' | 'mobile', BannerImage>> = {};
    let committed = false;
    try {
      if (desktopFile) uploaded.desktop = await this.storage.upload(desktopFile, 'desktop');
      if (mobileFile) uploaded.mobile = await this.storage.upload(mobileFile, 'mobile');
      const imageFields = {
        ...(uploaded.desktop && { desktopImageUrl: uploaded.desktop.url, desktopImagePublicId: uploaded.desktop.publicId }),
        ...(uploaded.mobile && { mobileImageUrl: uploaded.mobile.url, mobileImagePublicId: uploaded.mobile.publicId }),
      };
      const item = await this.banners.findByIdAndUpdate(id, { $set: { ...this.clean(input), ...imageFields, updatedBy: new Types.ObjectId(actorId) } }, { new: true, runValidators: true });
      committed = true;
      await this.audit(new Types.ObjectId(actorId), previous.active !== input.active && input.active !== undefined ? 'HOME_BANNER_STATUS_CHANGED' : 'HOME_BANNER_UPDATED', new Types.ObjectId(id)).catch(() => undefined);
      const obsolete = [uploaded.desktop && previous.desktopImagePublicId, uploaded.mobile && previous.mobileImagePublicId].filter((value): value is string => Boolean(value));
      await Promise.allSettled(obsolete.map(publicId => this.storage.remove(publicId)));
      return item;
    } catch (error) {
      if (!committed) await Promise.allSettled(Object.values(uploaded).map(image => this.storage.remove(image.publicId)));
      throw error;
    }
  }

  async remove(id: string, actorId: string) {
    this.validId(id);
    const item = await this.banners.findByIdAndDelete(id);
    if (!item) throw new NotFoundException('Banner não encontrado.');
    await Promise.allSettled([this.storage.remove(item.desktopImagePublicId), this.storage.remove(item.mobileImagePublicId)]);
    await this.audit(new Types.ObjectId(actorId), 'HOME_BANNER_DELETED', item._id).catch(() => undefined);
    return { message: 'Banner excluído com sucesso.' };
  }

  private validateImage(file: BannerUploadFile) {
    if (file.size > 5 * 1024 * 1024) throw new BadRequestException('Esta imagem é muito grande. O tamanho máximo permitido é 5 MB.');
    if (!isAllowedBannerImage(file)) throw new BadRequestException('Formato de arquivo não permitido.');
  }

  private clean<T extends CreateHomeBannerDto | UpdateHomeBannerDto>(input: T) { return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]).filter(([key, value]) => value !== '' || key === 'targetUrl').map(([key, value]) => [key, key === 'targetUrl' && value === '' ? null : value])); }
  private validId(id: string) { if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Banner não encontrado.'); }
  private audit(actorId: Types.ObjectId, action: string, targetId: Types.ObjectId) { return this.audits.create({ actorId, action, targetType: 'HomeBanner', targetId }); }
}
